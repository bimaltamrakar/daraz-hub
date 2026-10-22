# Daraz Store Hub

Multi-tenant seller-store management using React, Express, Supabase-hosted PostgreSQL, and Prisma. The API owns authentication and store-token storage; the browser receives only an access JWT and non-sensitive store status.

## Architecture and schema

- **Web:** React 19 + Vite single-page dashboard; access JWT held in memory, refresh credential sent only as an HttpOnly cookie.
- **API:** Express 5 + TypeScript, Zod input validation, Helmet, strict credentialed CORS, rate-limited authentication/refresh actions, ownership checks on store operations.
- **Database:** Supabase-hosted PostgreSQL + Prisma migrations. `DATABASE_URL` is the Supavisor transaction-pooler URL used by the running API; `DIRECT_URL` is the session-pooler URL used by Prisma migrations and administration. `User` (role/status/forced password change), `Session` (hashed refresh credentials), `Store`, `StoreToken` (AES-256-GCM token ciphertext and expiry metadata), `OAuthState` (single-use expiring state bound to user/store), and `AuditLog`.
- **Deployment:** Docker Compose runs the app and optional nginx TLS reverse proxy. PostgreSQL is hosted by Supabase; Compose does not start a local database.

## Start locally

1. Create a Supabase project and note its database password and project region. In **Project Settings → Database → Connection string**, choose the **Supavisor transaction pooler** URL for runtime and the **Supavisor session pooler** URL for Prisma migrations. Keep the password URL-encoded if it contains reserved characters.
2. Install Node.js 22+ and Docker. Copy `.env.example` to `.env`, replace both sample Supabase URLs with the connection strings for your project, and generate app secrets, for example:
   - `JWT_ACCESS_SECRET`: `openssl rand -base64 48`
   - `TOKEN_ENCRYPTION_KEY`: `openssl rand -hex 32`
3. Set a strong `ADMIN_PASSWORD` (at least 12 characters with upper/lowercase, number, and symbol) and `ADMIN_EMAIL`.
4. Run `npm install`, `npm run db:generate`, `npm run db:migrate`, and `npm run db:seed`. These commands use `DIRECT_URL` and create the app tables in the Supabase database. The production container runs migrations and the idempotent admin seed on startup.
5. Run `npm run dev`. The API is at `http://localhost:4000`; Vite is at `http://localhost:5173`.

The seed is idempotent and does not overwrite an existing administrator. The initial administrator must change the environment-supplied password on first sign-in.

### Database connection notes

- Copy the Supavisor transaction-mode connection string (port `6543`) into `DATABASE_URL`; keep `pgbouncer=true` on the query string. This application uses Prisma's built-in PostgreSQL client.
- Copy the Supavisor session-mode connection string (port `5432`) into `DIRECT_URL`. Prisma's migration engine uses this unpooled/session connection.
- Both URLs must target the same Supabase project/database and use the same database role. The default `postgres.<project-ref>` role works; for production, consider creating a dedicated Prisma role with only the required schema permissions following the [Supabase Prisma guide](https://supabase.com/docs/guides/database/prisma).
- This application connects directly to Supabase PostgreSQL with Prisma. It does not use Supabase Auth, the Supabase REST/Data API, or browser-side Supabase credentials. Keep database URLs server-side; never add them to frontend variables.
- Enable network access for the host/container running the app in Supabase's database network restrictions if configured. Local development commands require network access to the database.

## Daraz Open Platform setup

Register an application in the [Daraz Open Platform console](https://open.daraz.com/app/index.htm), request the necessary seller permissions, and configure the callback as:

`https://YOUR_PUBLIC_HOST/api/oauth/daraz/callback`

Set `DARAZ_REGIONS_JSON` to a one-line JSON object keyed by two-letter marketplace code (for example `NP`). Each entry requires:

```json
{
  "NP": {
    "authorizeUrl": "SET_FROM_DARAZ_DOCUMENTATION",
    "apiBaseUrl": "https://api.daraz.com/rest",
    "appKey": "SET_FROM_DARAZ_CONSOLE",
    "appSecret": "SET_FROM_DARAZ_CONSOLE",
    "redirectUri": "https://YOUR_PUBLIC_HOST/api/oauth/daraz/callback"
  }
}
```

The seller authorization flow returns an authorization code to the registered callback. The API exchanges it using `/auth/token/create` and refreshes using `/auth/token/refresh` against `apiBaseUrl`. Requests use Lazop signing: sort request parameters by key, concatenate each key and value after the API path, then HMAC-SHA256 with the app secret and uppercase the hexadecimal signature. Token values are encrypted at rest; replace stored tokens with the newest access and refresh tokens returned by create or refresh. The authorization code expires after 30 minutes. Refer to Daraz's [Seller Authorization Introduction](https://open.daraz.com/doc/doc.htm?#/?docId=490) for the documented flow and response fields.

For backward compatibility, an existing `tokenUrl` field can remain in the region configuration; when `apiBaseUrl` is absent the app uses Daraz's documented `https://api.daraz.com/rest` service address. `refreshUrl` and `signingMode` are no longer needed. The Daraz `appSecret` is accepted only from environment configuration and must never be committed. Use the correct per-market values and callback configuration from the application console.

## Production deployment

Set strong unique secrets and `COOKIE_SECURE=true`, ensure the Supabase project has suitable backups and resource limits, provide nginx certificates at `./certs/fullchain.pem` and `./certs/privkey.pem`, and set `APP_ORIGIN` to the HTTPS origin. Then run `docker compose --profile production up --build -d`. The app container runs Prisma migrations against `DIRECT_URL` and seeds the administrator on startup. Keep `.env` out of source control. Back up the Supabase database and encryption key together; rotating the encryption key requires re-encrypting stored credentials.

## API and tests

- OpenAPI documentation: `openapi.yaml`; endpoint index is also available at `GET /api/openapi.json`.
- Authentication: `POST /api/auth/signup`, `/login`, `/refresh`, `/logout`, `/password`.
- Stores: `GET/POST /api/stores`, `DELETE /api/stores/:id`, `POST /api/stores/:id/connect`, `/refresh`.
- Dashboard: `GET /api/dashboard`. Admin: `GET /api/admin/users`, `/stores`, `/audit`; `PATCH /api/admin/users/:id`.
- Run `npm test` for security and signing-helper unit tests; `npm run build` for type-check and production build.

The refresh/session cookie is HttpOnly, SameSite=Strict and Secure when configured. Store tokens are encrypted with AES-256-GCM and never returned. Audit logs intentionally exclude credentials and OAuth callback parameters.

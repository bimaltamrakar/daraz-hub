import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  OAUTH_STATE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  DARAZ_REGIONS_JSON: z.string().default("{}"),
}).refine((value) => value.NODE_ENV !== "production" || value.COOKIE_SECURE === "true", {
  message: "COOKIE_SECURE=true is required in production.",
});

export const config = schema.parse(process.env);
const darazRegionsJson = config.DARAZ_REGIONS_JSON.trim();
const darazRegionSchema = z.object({
  authorizeUrl: z.string().url(),
  apiBaseUrl: z.string().url().optional(),
  tokenUrl: z.string().url().optional(),
  refreshUrl: z.string().url().optional(),
  appKey: z.string().min(1),
  appSecret: z.string().min(1),
  redirectUri: z.string().url(),
  signingMode: z.string().optional(),
}).refine((region) => Boolean(region.apiBaseUrl || region.tokenUrl), {
  message: "Each Daraz region must set apiBaseUrl.",
});

export const darazRegions = z.record(z.string(), darazRegionSchema).parse(darazRegionsJson ? JSON.parse(darazRegionsJson) : {});

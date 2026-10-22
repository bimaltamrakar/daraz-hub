process.env.NODE_ENV = "test";
process.env.APP_ORIGIN = "http://localhost:5173";
process.env.DATABASE_URL = "postgresql://test:test@aws-0-us-east-1.pooler.supabase.com:6543/test?pgbouncer=true";
process.env.DIRECT_URL = "postgresql://test:test@aws-0-us-east-1.pooler.supabase.com:5432/test";
process.env.DARAZ_REGIONS_JSON = JSON.stringify({
  NP: {
    authorizeUrl: "https://api.daraz.com.np/oauth/authorize",
    apiBaseUrl: "https://api.daraz.com/rest",
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    redirectUri: "https://example.test/api/oauth/daraz/callback",
  },
  // No apiBaseUrl: the REST gateway must be derived from the authorize URL host.
  PK: {
    authorizeUrl: "https://api.daraz.pk/oauth/authorize",
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    redirectUri: "https://example.test/api/oauth/daraz/callback",
  },
});
process.env.JWT_ACCESS_SECRET = "test-secret-with-more-than-thirty-two-characters";
process.env.TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

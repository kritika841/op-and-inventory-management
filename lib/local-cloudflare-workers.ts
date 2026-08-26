// Local Node preview shim. Production workers receive these values from
// Cloudflare bindings through the real `cloudflare:workers` module.
const names = [
  "SUPABASE_DATABASE_URL", "APP_MODE", "APP_BASE_URL", "APP_ALLOWED_ORIGINS", "SESSION_SECRET", "PASSWORD_PEPPER",
  "TOKEN_ENCRYPTION_KEY", "INITIAL_ADMIN_EMAIL", "INITIAL_ADMIN_TEMP_PASSWORD",
  "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_SHOP_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN",
  "SHOPIFY_API_VERSION", "SHOPIFY_REDIRECT_URI", "SHIPROCKET_EMAIL", "SHIPROCKET_PASSWORD",
  "SHIPROCKET_CHANNEL_ID", "SHIPROCKET_WEBHOOK_SECRET",
] as const;

export const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));

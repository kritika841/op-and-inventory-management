# Satmi Operations

Order, fulfillment, inventory, confirmation, and RTO operations backed by Supabase Postgres. The application has no SQLite or Cloudflare D1 runtime fallback and does not persist UI state in browser storage.

## Required configuration

Copy `.env.example` to `.env` and provide real values. The app requires `SUPABASE_DATABASE_URL`, `SESSION_SECRET`, and `PASSWORD_PEPPER` for authentication. Shopify and Shiprocket secrets are validated when their integrations or webhooks are used, but do not block dashboard sign-in.

Use the Supabase transaction pooler connection string on port `6543` for the running application. Use a direct or session-pooler connection for schema migration and the one-time bulk import when available.

No default email or password is embedded in the application. `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_TEMP_PASSWORD` are required only if the target database has no users. Existing password hashes are preserved during migration.

## Supabase migration

The checked-in migration is `supabase/migrations/202608140001_initial_satmi.sql`. It creates the Postgres schema, enables RLS on every table, and enforces canonical order identity through the generated, unique `orders.normalized_order_number` column.

The legacy data file is retained only as an immutable migration source in `backups/d1-pre-supabase-20260814.sqlite`; it is not read by the application at runtime.

```bash
# Reconcile locally without writing to Supabase.
npm run db:reconcile:dry-run

# Apply schema and import the reconciled backup into an empty Supabase database.
SUPABASE_DATABASE_URL='postgresql://...' npm run db:migrate:supabase
```

The importer refuses a non-empty destination unless `--allow-nonempty` is explicitly supplied. It rewrites child records to canonical orders, validates the final order count, and writes `backups/supabase-reconciliation-report.json`.

Current verified dry-run totals:

- Source order rows: `4,416`
- Canonical orders: `3,200`
- Duplicate rows reconciled: `1,216`

Keep `backups/d1-pre-supabase-20260814.sqlite` and its SHA-256 file unchanged until production reconciliation is signed off.

## Synchronization

The first Shopify and Shiprocket sync performs a full historical backfill. Later runs use the provider cursor in `integration_sync_cursors` with an overlap window so late updates are reconciled instead of missed. Filters always use synchronized Supabase data.

Provider webhooks require valid secrets and atomically claim deterministic receipt IDs. Duplicate deliveries return successfully without repeating work; failed processing releases the claim so the provider can retry.

Administrators and managers can query `GET /api/admin/integrations/health`. It checks Supabase, stored sync cursors, configured integration state, and a live authenticated Shiprocket probe; unhealthy results return HTTP `503`.

## Performance

`/api/state` no longer includes audit history and no longer reloads on a timer, focus, or visibility changes. Audit history is fetched only when its submenu opens through paginated `/api/audits`. `/api/orders` provides role-aware `limit`/`offset` pagination, exact comma-separated order ID matching, free-text search, and bounded page sizes. Long table rows use browser rendering containment, and realtime updates remain SSE-driven.

## Validation

```bash
npm run lint
npm run typecheck
npm test
```

Do not start the application until the Supabase schema and migration validation complete. A local server will intentionally fail closed without `SUPABASE_DATABASE_URL` and the authentication secrets.

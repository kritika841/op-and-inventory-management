import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships Satmi inventory metadata and removes starter preview", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);
  assert.match(page, /InventoryApp/);
  assert.match(layout, /Satmi Inventory/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("uses Supabase for relational data and retains only label object storage", async () => {
  const hosting = JSON.parse(await readFile(new URL(".openai/hosting.json", root), "utf8"));
  assert.deepEqual(hosting, { r2: "LABELS" });
});

test("includes manual sales and inventory movement logging", async () => {
  const [ui, sales, migration] = await Promise.all([
    readFile(new URL("app/InventoryApp.tsx", root), "utf8"),
    readFile(new URL("lib/manual-sales.ts", root), "utf8"),
    readFile(new URL("supabase/migrations/202608140001_initial_satmi.sql", root), "utf8"),
  ]);
  assert.match(ui, /Manual sales/);
  assert.match(ui, /Inventory log/);
  assert.match(sales, /manual-sale/);
  assert.match(sales, /manual-rto/);
  assert.match(migration, /create table if not exists manual_sale_components/);
});

test("includes date-range order insights backed by Shiprocket shipment events and migrations", async () => {
  const [ui, webhook, migration, integrations] = await Promise.all([
    readFile(new URL("app/InventoryApp.tsx", root), "utf8"),
    readFile(new URL("app/api/webhooks/logistics/route.ts", root), "utf8"),
    readFile(new URL("supabase/migrations/202608140001_initial_satmi.sql", root), "utf8"),
    readFile(new URL("lib/integrations.ts", root), "utf8"),
  ]);
  assert.match(ui, /Order insights/);
  assert.match(ui, /What do you want to review/);
  assert.match(ui, /AWB generated/);
  assert.match(ui, /<p>ORDERS<\/p>/);
  assert.match(ui, /PRODUCT PERFORMANCE/);
  assert.match(ui, /All products/);
  assert.match(ui, /iv-product-insight-grid/);
  assert.match(ui, /Show all \$\{productRows.length\} products/);
  assert.match(ui, /aria-pressed=\{statusFilters\.includes\(status\)\}/);
  assert.match(ui, /AWB not generated/);
  assert.match(ui, /Cancelled before AWB/);
  assert.match(ui, /Cancelled after AWB/);
  assert.match(ui, /Later cancelled/);
  assert.match(ui, /cancellationStatuses\.map/);
  assert.match(ui, /Cancellation details/);
  assert.match(ui, /isAwbMissing/);
  assert.match(ui, /iv-multi-filter/);
  assert.match(ui, /iv-order-products/);
  assert.match(ui, /Remove order filters/);
  assert.match(webhook, /tracking_events/);
  assert.match(webhook, /PICKED_UP/);
  assert.match(webhook, /SHIPMENT_AUTO_CANCELLED/);
  assert.match(migration, /create table if not exists shipment_events/);
  assert.match(migration, /cancellation_reason/);
  assert.match(integrations, /cancelReason/);
  assert.match(integrations, /attributeToUser/);
  assert.match(integrations, /AWB was cancelled or removed after generation/);
  assert.match(integrations, /awb=COALESCE\(\?11,orders\.awb\)/);
});

test("requires checked-in Supabase migrations instead of runtime schema bootstrap", async () => {
  const [database, readme, packageJson, migration] = await Promise.all([
    readFile(new URL("lib/database.ts", root), "utf8"),
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("supabase/migrations/202608140001_initial_satmi.sql", root), "utf8"),
  ]);
  assert.doesNotMatch(database, /CREATE TABLE IF NOT EXISTS/);
  assert.doesNotMatch(database, /PRAGMA table_info/);
  assert.match(database, /information_schema\.tables/);
  assert.match(readme, /Supabase Postgres/);
  assert.match(packageJson, /db:migrate:supabase/);
  assert.match(migration, /orders_normalized_number_unique/);
});

test("supports admin-side user deactivation with session invalidation", async () => {
  const [route, auth, ui] = await Promise.all([
    readFile(new URL("app/api/admin/users/route.ts", root), "utf8"),
    readFile(new URL("lib/auth.ts", root), "utf8"),
    readFile(new URL("app/OperationsApp.tsx", root), "utf8"),
  ]);
  assert.match(route, /body\.action === "deactivate"/);
  assert.match(route, /DELETE FROM sessions WHERE user_id=\?1/);
  assert.match(route, /You cannot deactivate your own account/);
  assert.match(route, /At least one active admin account must remain/);
  assert.match(route, /assigned_user_id=NULL/);
  assert.match(auth, /active=1/);
  assert.match(ui, /Deactivate/);
  assert.match(ui, /window\.confirm/);
});

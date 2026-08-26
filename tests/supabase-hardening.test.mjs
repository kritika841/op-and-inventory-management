import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Supabase is mandatory and insecure secret fallbacks are disabled", async () => {
  const [database, adapter, auth, ui, layout] = await Promise.all([
    source("lib/database.ts"), source("lib/postgres.ts"), source("lib/auth.ts"),
    source("app/OperationsApp.tsx"), source("app/layout.tsx"),
  ]);
  assert.match(adapter, /SUPABASE_DATABASE_URL is required/);
  assert.match(database, /insecure fallback values are disabled/);
  assert.doesNotMatch(auth, /Satmi@123|default-pepper|dev-secret/);
  assert.doesNotMatch(`${ui}\n${layout}`, /localStorage|sessionStorage/);
});

test("default High RTO campaign satisfies required ownership and is race safe", async () => {
  const database = await source("lib/database.ts");
  assert.match(database, /role IN \('ADMIN','MANAGER'\)/);
  assert.match(database, /cmp_default_high_rto/);
  assert.match(database, /ON CONFLICT\(id\) DO NOTHING RETURNING id/);
  assert.doesNotMatch(database, /position,created_by,created_at,is_active\) VALUES \([^\n]*NULL/);
  assert.match(database, /core workspace must remain available/);
  assert.match(database, /rto_prediction_high/);
  assert.match(database, /tags: \["high", "rto_prediction_high"\]/);
});

test("high-RTO Shopify tags always route to confirmation and campaign selection pages newest first", async () => {
  const [state, shopifyWebhook, ui, stateRoute] = await Promise.all([
    source("lib/state.ts"), source("app/api/webhooks/shopify/route.ts"),
    source("app/OperationsApp.tsx"), source("app/api/state/route.ts"),
  ]);
  assert.match(state, /new Set\(\["high", "rto_prediction_high"\]\)/);
  assert.match(state, /String\(candidate\.id\) === "cmp_default_high_rto"/);
  assert.match(state, /confirmation_selected=1,confirmation_status='assigned'/);
  assert.match(shopifyWebhook, /await assignOrderToLongTermCampaign\(orderId\)/);
  assert.match(ui, /queue=campaign-selection/);
  assert.match(ui, /validDate\(right\.createdAt\).*validDate\(left\.createdAt\)/);
  assert.match(ui, /campaignSourcePage\.hasMore/);
  assert.match(stateRoute, /campaign-selection/);
});

test("migration enforces canonical order identity and the dry run reconciles every duplicate", async () => {
  const [migration, reportText, checksum] = await Promise.all([
    source("supabase/migrations/202608140001_initial_satmi.sql"),
    source("backups/supabase-reconciliation-report.json"),
    source("backups/d1-pre-supabase-20260814.sha256"),
  ]);
  const report = JSON.parse(reportText);
  assert.match(migration, /normalized_order_number text generated always/);
  assert.match(migration, /unique\(normalized_order_number\)/i);
  assert.match(migration, /orders_shopify_id_unique/);
  assert.match(migration, /orders_shiprocket_id_unique/);
  assert.equal(report.sourceOrderRows, 4416);
  assert.equal(report.canonicalOrders, 3200);
  assert.equal(report.duplicatesRemoved, 1216);
  assert.equal(report.sourceOrderRows - report.canonicalOrders, report.duplicatesRemoved);
  assert.match(checksum, /^[a-f0-9]{64}\s+/);
});

test("provider webhooks fail closed and atomically claim deterministic receipts", async () => {
  const [shopify, shiprocket] = await Promise.all([
    source("app/api/webhooks/shopify/route.ts"),
    source("app/api/webhooks/logistics/route.ts"),
  ]);
  assert.match(shopify, /status: 503/);
  assert.match(shopify, /shopify_.*sha256/);
  assert.match(shopify, /ON CONFLICT\(id\) DO NOTHING/);
  assert.match(shopify, /DELETE FROM webhook_receipts/);
  assert.match(shiprocket, /status: 503/);
  assert.match(shiprocket, /safeEqual/);
  assert.match(shiprocket, /request\.headers\.entries\(\)/);
  assert.match(shiprocket, /configured token was not found in request headers/);
  assert.match(shiprocket, /shiprocket_.*sha256/);
  assert.match(shiprocket, /ON CONFLICT\(id\) DO NOTHING/);
  assert.match(shiprocket, /Unknown Shiprocket status/);
  assert.match(shiprocket, /DELETE FROM webhook_receipts/);
});

test("sync performs full first backfill and cursor-based incremental reconciliation", async () => {
  const integrations = await source("lib/integrations.ts");
  assert.match(integrations, /integration_sync_cursors/);
  assert.match(integrations, /full_backfill_complete/);
  assert.match(integrations, /mode: incrementalSince \? "incremental" : "full"/);
  assert.match(integrations, /shipment\.awb_code/);
  assert.match(integrations, /shipment\.awb_number/);
  assert.match(integrations, /shipment\.current_status_id/);
  assert.match(integrations, /Commit progress after every provider page/);
  assert.match(integrations, /const pagesPerRun = 5/);
  assert.doesNotMatch(integrations, /60\s*\*\s*24\s*\*\s*60\s*\*\s*60/);
});

test("integration health is deterministic, protected, and reports database plus Shiprocket state", async () => {
  const [health, integrations] = await Promise.all([
    source("app/api/admin/integrations/health/route.ts"), source("lib/integrations.ts"),
  ]);
  assert.match(health, /authorizeRequest\(request, \["ADMIN", "MANAGER"\]\)/);
  assert.match(health, /provider: "supabase-postgres"/);
  assert.match(health, /status: integrationHealthy \? 200 : 503/);
  assert.match(integrations, /checkShiprocketConnectivity/);
  assert.match(integrations, /searchParams\.set\("per_page", "1"\)/);
});

test("heavy state is split into protected paginated endpoints without polling reloads", async () => {
  const [audits, orders, stateRoute, state, ui] = await Promise.all([
    source("app/api/audits/route.ts"), source("app/api/orders/route.ts"),
    source("app/api/state/route.ts"), source("lib/state.ts"), source("app/OperationsApp.tsx"),
  ]);
  assert.match(audits, /authorizeRequest\(request, \["ADMIN", "MANAGER"\]\)/);
  assert.match(audits, /Math\.min\(200/);
  assert.match(orders, /authorizeRequest\(request\)/);
  assert.match(orders, /normalized_order_number IN/);
  assert.match(orders, /hasMore/);
  assert.match(state, /WHERE 1=0/);
  assert.match(state, /fulfillmentCounts/);
  assert.match(state, /fulfillment_shipment\.picked_up_at IS NOT NULL/);
  assert.match(stateRoute, /queue.*new-orders.*labels-generated.*shipped.*confirmed-orders/s);
  assert.match(stateRoute, /order-asc/);
  assert.match(state, /normalized_order_number LIKE 'SI%'.*normalized_order_number ASC/);
  assert.match(ui, /75/);
  assert.match(ui, /activeQueueTotal/);
  assert.match(ui, /fulfillmentActivityMs/);
  assert.match(ui, /const pageSize = offset === 0 \? 25 : 75/);
  assert.match(ui, /const openQueue = \(queue: FulfillmentQueueKey\)/);
  assert.match(ui, /Order ID: ascending/);
  assert.match(ui, /Shipment updated/);
  assert.match(state, /latest_shipment_event_at/);
  assert.match(state, /fulfillmentQueue === "shipped"/);
  assert.doesNotMatch(ui, /loaded · \{activeQueueTotal\}/);
  assert.match(ui, /RTO initiated/);
  assert.match(ui, /RTO in transit/);
  assert.match(ui, /RTO received/);
  assert.match(ui, /QC pending/);
  assert.match(ui, /QC resolved/);
  assert.doesNotMatch(ui, /setInterval|visibilitychange|addEventListener\("focus"/);
  assert.match(ui, /if \(!auditLoaded\) void loadAudits\(\)/);
});

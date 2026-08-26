import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const args = new Set(process.argv.slice(2));
const valueAfter = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const sourcePath = valueAfter("--source", "backups/d1-pre-supabase-20260814.sqlite");
const targetUrl = valueAfter("--target", process.env.SUPABASE_DATABASE_URL || "");
const dryRun = args.has("--dry-run");
const applySchema = args.has("--apply-schema");
const allowNonempty = args.has("--allow-nonempty");

const tables = [
  "users", "sessions", "products", "orders", "order_lines", "order_tags", "inventory_ledger",
  "confirmation_attempts", "order_edit_requests", "campaigns", "campaign_assignments", "recall_cooldown_settings",
  "recall_overrides", "labels", "rto_tasks", "webhook_receipts", "integration_state", "audit_events",
  "inventory_components", "component_ledger", "packaging_profiles", "recipe_versions", "recipe_items",
  "packaging_box_options", "order_requirement_sets", "order_requirements", "packaging_plans", "packaging_plan_lines",
  "rto_qc_lines", "component_types", "manual_sales", "manual_sale_components", "shipment_events", "shipments",
  "tracking_events", "order_status_log", "courier_sla",
];

const orderChildTables = new Set([
  "order_lines", "order_tags", "confirmation_attempts", "order_edit_requests", "campaign_assignments", "labels",
  "rto_tasks", "recall_overrides", "order_requirement_sets", "order_requirements", "packaging_plans", "shipment_events",
  "shipments", "tracking_events", "order_status_log",
]);

const statusRank = new Map([
  "INGESTED", "RTO_CHECK_PENDING", "PENDING_CONFIRMATION", "RETRY_SCHEDULED", "CALLBACK_SCHEDULED", "APPROVED",
  "INVENTORY_CHECK", "ON_HOLD_INVENTORY", "READY_TO_MANIFEST", "MANIFESTED", "LABEL_PRINTED", "PICKUP_SCHEDULED",
  "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "AUTO_CANCEL_RISK", "SHIPMENT_AUTO_CANCELLED",
  "RTO_INITIATED", "RTO_IN_TRANSIT", "RTO_RECEIVED", "RTO_INSPECTION_PENDING", "RTO_RESTOCKED", "RTO_DAMAGED",
  "CANCELED",
].map((status, index) => [status, index]));

function normalizedOrderNumber(value) {
  return String(value || "").replace(/^#/, "").trim().toUpperCase();
}

function sourceScore(row) {
  return (row.shopify_order_id ? 100 : 0) + (row.shiprocket_order_id ? 40 : 0) + (row.awb ? 20 : 0) +
    (row.label_key ? 10 : 0) + (row.shipping_address ? 5 : 0) + (row.assigned_user_id ? 3 : 0);
}

function bestStatus(rows) {
  return rows.map((row) => row.current_status).filter(Boolean).sort((a, b) => (statusRank.get(b) ?? -1) - (statusRank.get(a) ?? -1))[0];
}

function mergeOrders(rows, canonical) {
  const merged = { ...canonical };
  const fillFields = [
    "shopify_order_id", "shopify_customer_id", "customer_phone", "assigned_agent_id", "stuck_reason", "stuck_since",
    "stuck_notes", "assigned_user_id", "shiprocket_order_id", "shipment_id", "awb", "courier", "tracking_status",
    "cancellation_source", "cancellation_reason", "cancelled_by", "cancelled_at", "label_key", "rto_eta",
    "shipping_address", "shipping_city", "shipping_state", "shipping_pincode", "shipping_country",
  ];
  for (const field of fillFields) merged[field] = rows.find((row) => row[field] !== null && row[field] !== "")?.[field] ?? merged[field];
  merged.current_status = bestStatus(rows) ?? merged.current_status;
  merged.created_at = rows.map((row) => row.created_at).filter(Boolean).sort()[0] ?? merged.created_at;
  merged.updated_at = rows.map((row) => row.updated_at).filter(Boolean).sort().at(-1) ?? merged.updated_at;
  merged.confirmation_selected = Math.max(...rows.map((row) => Number(row.confirmation_selected || 0)));
  merged.warehouse_acknowledged = Math.max(...rows.map((row) => Number(row.warehouse_acknowledged || 0)));
  return merged;
}

function selectSourceByRows(rows, tableRows, quality = () => 0) {
  return [...rows].sort((a, b) => {
    const aChildren = tableRows.filter((row) => row.order_id === a.id);
    const bChildren = tableRows.filter((row) => row.order_id === b.id);
    return (quality(bChildren) - quality(aChildren)) || (bChildren.length - aChildren.length) || (sourceScore(b) - sourceScore(a));
  })[0]?.id;
}

const source = new DatabaseSync(sourcePath, { readOnly: true });
const availableTables = new Set(source.prepare("select name from sqlite_master where type='table'").all().map((row) => row.name));
const data = Object.fromEntries(tables.map((table) => [table, availableTables.has(table) ? source.prepare(`select * from ${table}`).all() : []]));
const lineOriginalOrder = new Map(data.order_lines.map((row) => [row.id, row.order_id]));
const requirementOriginalOrder = new Map(data.order_requirements.map((row) => [row.id, row.order_id]));

const groups = new Map();
for (const order of data.orders) {
  const key = normalizedOrderNumber(order.order_number);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(order);
}

const idMap = new Map();
const canonicalOrders = [];
const selectedLineSource = new Map();
const selectedRequirementSource = new Map();
for (const rows of groups.values()) {
  const canonical = [...rows].sort((a, b) => sourceScore(b) - sourceScore(a) || String(a.id).localeCompare(String(b.id)))[0];
  for (const row of rows) idMap.set(row.id, canonical.id);
  canonicalOrders.push(mergeOrders(rows, canonical));
  selectedLineSource.set(canonical.id, selectSourceByRows(rows, data.order_lines, (children) => children.filter((line) => line.sku && line.sku !== "INVALID-SKU").length));
  selectedRequirementSource.set(canonical.id, selectSourceByRows(rows, data.order_requirements));
}
data.orders = canonicalOrders;

for (const table of orderChildTables) {
  data[table] = data[table].map((row) => ({ ...row, order_id: idMap.get(row.order_id) ?? row.order_id }));
}

// Keep exactly one provider's line set per canonical order; line IDs remain unchanged for auditability.
data.order_lines = data.order_lines.filter((row) => selectedLineSource.get(row.order_id) === lineOriginalOrder.get(row.id));
data.order_requirements = data.order_requirements.filter((row) => selectedRequirementSource.get(row.order_id) === requirementOriginalOrder.get(row.id));

const uniqueBy = (rows, key) => [...new Map(rows.map((row) => [key(row), row])).values()];
data.order_tags = uniqueBy(data.order_tags, (row) => `${row.order_id}:${String(row.tag).toLowerCase()}`);
data.campaign_assignments = uniqueBy(data.campaign_assignments.sort((a, b) => Number(a.position) - Number(b.position)), (row) => row.order_id);
data.order_requirement_sets = uniqueBy(data.order_requirement_sets, (row) => row.order_id);
data.packaging_plans = uniqueBy(data.packaging_plans, (row) => row.order_id);
data.rto_tasks = uniqueBy(data.rto_tasks, (row) => row.order_id);

const report = {
  generatedAt: new Date().toISOString(),
  source: path.resolve(sourcePath),
  sourceOrderRows: [...groups.values()].reduce((sum, rows) => sum + rows.length, 0),
  canonicalOrders: data.orders.length,
  duplicatesRemoved: [...groups.values()].reduce((sum, rows) => sum + Math.max(0, rows.length - 1), 0),
  duplicateGroups: [...groups.entries()].filter(([, rows]) => rows.length > 1).map(([orderNumber, rows]) => ({ orderNumber, sourceIds: rows.map((row) => row.id), canonicalId: idMap.get(rows[0].id) })),
  rowCounts: Object.fromEntries(tables.map((table) => [table, data[table].length])),
};

await mkdir("backups", { recursive: true });
await writeFile("backups/supabase-reconciliation-report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ sourceOrderRows: report.sourceOrderRows, canonicalOrders: report.canonicalOrders, duplicatesRemoved: report.duplicatesRemoved }, null, 2));

if (dryRun) process.exit(0);
if (!targetUrl) throw new Error("SUPABASE_DATABASE_URL or --target is required for migration");

const sql = postgres(targetUrl, { max: 1, prepare: false, ssl: "require" });
try {
  if (applySchema) await sql.unsafe(await readFile("supabase/migrations/202608140001_initial_satmi.sql", "utf8"));
  const existing = await sql`select count(*)::int as count from orders`;
  if (Number(existing[0]?.count || 0) && !allowNonempty) throw new Error("Supabase destination is not empty. Refusing migration without --allow-nonempty.");

  await sql.begin(async (transaction) => {
    for (const table of tables) {
      const rows = data[table];
      for (let offset = 0; offset < rows.length; offset += 250) {
        const chunk = rows.slice(offset, offset + 250);
        if (!chunk.length) continue;
        const columns = Object.keys(chunk[0]);
        const values = [];
        const tuples = chunk.map((row, rowIndex) => `(${columns.map((column, columnIndex) => {
          values.push(row[column]);
          return `$${rowIndex * columns.length + columnIndex + 1}`;
        }).join(",")})`).join(",");
        const quotedColumns = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(",");
        await transaction.unsafe(`insert into "${table}" (${quotedColumns}) values ${tuples} on conflict do nothing`, values);
      }
    }
  });

  const targetCount = await sql`select count(*)::int as count from orders`;
  if (Number(targetCount[0]?.count) !== report.canonicalOrders) throw new Error(`Target validation failed: expected ${report.canonicalOrders} orders, found ${targetCount[0]?.count}`);
  console.log(`Migration complete: ${targetCount[0].count} canonical orders in Supabase.`);
} finally {
  await sql.end();
}

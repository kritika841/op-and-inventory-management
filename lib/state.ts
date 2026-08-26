import { audit, ensureDatabase, ensureDefaultHighRtoCampaign, getEnv } from "./database";
import { randomHex } from "./crypto";
import { deriveBlocker, inventoryAvailability, isProcessed } from "./domain.mjs";
import type { AppUser, CampaignCriteria, CampaignDuplicateMode, CampaignUrgency, DashboardSnapshot, InventoryView, OrderView, RtoOrderView, RtoTaskView } from "./types";
import { reallocateComponents, snapshotOrderRequirements } from "./components";
import { updateShopifyOrderContact } from "./integrations";
import { getUserDeleteGuard } from "./users";
import { broadcastOrderUpdate } from "./realtime";

type Row = Record<string, unknown>;
// Fulfillment is an operational queue, not a recent-activity preview. Keep
// the snapshot complete so queue counts and tabs cannot silently omit orders.
const DEFAULT_DASHBOARD_ORDER_LIMIT = 75;
const INITIAL_ACTIVITY_LIMIT = 150;
const RTO_ORDER_PREDICATE = "(o.status IN ('rto_initiated','rto_in_transit','rto_delivered') OR o.current_status IN ('RTO_INITIATED','RTO_IN_TRANSIT','RTO_RECEIVED','RTO_INSPECTION_PENDING','RTO_RESTOCKED','RTO_DAMAGED'))";

function bool(value: unknown) { return Boolean(Number(value)); }
function num(value: unknown) { return Number(value ?? 0); }
function validDateValue(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : String(value);
}
function splitAddressFields(value: string) {
  const parts = value.split(",").map((item) => item.trim()).filter(Boolean);
  const country = parts.length >= 5 ? parts.pop() ?? "" : "";
  const shipping_pincode = parts.length >= 4 ? parts.pop() ?? "" : "";
  const shipping_state = parts.length >= 3 ? parts.pop() ?? "" : "";
  const shipping_city = parts.length >= 2 ? parts.pop() ?? "" : "";
  const shipping_address = parts.join(", ");
  return { shipping_address, shipping_city, shipping_state, shipping_pincode, shipping_country: country };
}

function parseCampaignCriteria(value: unknown): CampaignCriteria | null {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown>;
    const readArray = (input: unknown) => Array.isArray(input) ? input.map((item) => String(item)).filter(Boolean) : [];
    const duplicateMode = String(parsed.duplicateMode || (parsed.duplicateOnly ? "NAME_PHONE_PRODUCT" : "NONE"));
    return {
      duplicateOnly: duplicateMode !== "NONE",
      duplicateMode: (["NONE", "NAME_PHONE_PRODUCT", "SHOPIFY_CUSTOMER_PRODUCT", "PHONE_OR_ADDRESS_PRODUCT"].includes(duplicateMode) ? duplicateMode : "NONE") as CampaignDuplicateMode,
      tags: readArray(parsed.tags),
      orderNumbers: readArray(parsed.orderNumbers),
      productNames: readArray(parsed.productNames),
      paymentMethod: String(parsed.paymentMethod || "ANY") as CampaignCriteria["paymentMethod"],
      previousUnfulfilledOnly: Boolean(parsed.previousUnfulfilledOnly),
      includeRtoRisk: parsed.includeRtoRisk === undefined ? true : Boolean(parsed.includeRtoRisk),
      autoAssignFutureMatching: Boolean(parsed.autoAssignFutureMatching),
    };
  } catch {
    return null;
  }
}

function stringifyCampaignCriteria(criteria: CampaignCriteria | null | undefined) {
  return criteria ? JSON.stringify(criteria) : null;
}

async function runSnapshotQueries<T>(queries: Array<() => Promise<T>>) {
  const results: T[] = [];
  for (const query of queries) results.push(await query());
  return results;
}

export type FulfillmentQueue = "all" | "new-orders" | "labels-generated" | "shipped" | "confirmed-orders" | "campaign-selection";

export async function getSnapshot(currentUser: AppUser, orderLimit = DEFAULT_DASHBOARD_ORDER_LIMIT, orderOffset = 0, fulfillmentQueue: FulfillmentQueue = "all"): Promise<DashboardSnapshot> {
  await ensureDatabase();
  // A live workspace may gain its first confirmation agent after boot. Recheck
  // the idempotent default rule here so High RTO becomes available immediately.
  try { await ensureDefaultHighRtoCampaign(); }
  catch (error) { console.error("[state] default High RTO campaign setup deferred", error); }
  const db = getEnv().DB;
  // Establish one healthy pooler connection before the independent dashboard
  // reads begin. This keeps a brief DNS failure from faning out across every
  // section of the workspace.
  await db.prepare("SELECT 1").all();
  const inventoryLogReset = await db.prepare("SELECT detail FROM audit_events WHERE action='inventory-log.cleared' ORDER BY created_at DESC LIMIT 1").first<Row>();
  const inventoryLogVisibleFrom = inventoryLogReset?.detail ? String(inventoryLogReset.detail) : null;
  const safeOrderLimit = Math.max(0, Math.min(200, Math.floor(orderLimit)));
  const safeOrderOffset = Math.max(0, Math.floor(orderOffset));
  const shippedActivityExpression = `COALESCE(
    (SELECT MAX(te.event_timestamp) FROM tracking_events te WHERE te.order_id=o.id AND te.event_tag IN ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','RTO_INITIATED','RTO_IN_TRANSIT','RTO_RECEIVED','RTO_INSPECTION_PENDING','RTO_RESTOCKED','RTO_DAMAGED')),
    (SELECT MAX(sh.picked_up_at) FROM shipments sh WHERE sh.order_id=o.id AND sh.is_active=1),
    o.created_at
  )`;
  let orderQuery = `SELECT o.*,u.name AS assigned_user_name,${shippedActivityExpression} AS latest_shipment_event_at FROM orders o LEFT JOIN users u ON u.id=o.assigned_user_id`;
  let orderScope = "SELECT o.id FROM orders o";
  let orderCountQuery = "SELECT COUNT(DISTINCT o.id) AS count FROM orders o";
  const courierActivePredicate = `(o.current_status IN ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','RTO_INITIATED','RTO_IN_TRANSIT','RTO_RECEIVED','RTO_INSPECTION_PENDING','RTO_RESTOCKED','RTO_DAMAGED') OR EXISTS (SELECT 1 FROM shipments fulfillment_shipment WHERE fulfillment_shipment.order_id=o.id AND fulfillment_shipment.is_active=1 AND fulfillment_shipment.picked_up_at IS NOT NULL))`;
  const labelEvidencePredicate = `(COALESCE(o.awb,'')<>'' OR o.current_status IN ('MANIFESTED','LABEL_PRINTED','PICKUP_SCHEDULED','AUTO_CANCEL_RISK'))`;
  const queuePredicates: Record<Exclude<FulfillmentQueue, "all" | "campaign-selection">, string> = {
    "new-orders": `o.status<>'cancelled' AND o.confirmation_selected=0 AND NOT ${labelEvidencePredicate} AND NOT ${courierActivePredicate}`,
    "labels-generated": `o.status<>'cancelled' AND ${labelEvidencePredicate} AND NOT ${courierActivePredicate}`,
    shipped: `o.status<>'cancelled' AND ${courierActivePredicate}`,
    "confirmed-orders": `o.status<>'cancelled' AND o.confirmation_status='confirmed' AND NOT ${labelEvidencePredicate} AND NOT ${courierActivePredicate}`,
  };
  let fulfillmentCountQuery = `SELECT
    COUNT(DISTINCT o.id) AS total,
    COUNT(DISTINCT o.id) FILTER (WHERE ${queuePredicates["new-orders"]}) AS new_orders,
    COUNT(DISTINCT o.id) FILTER (WHERE ${queuePredicates["labels-generated"]}) AS labels_generated,
    COUNT(DISTINCT o.id) FILTER (WHERE ${queuePredicates.shipped}) AS shipped,
    COUNT(DISTINCT o.id) FILTER (WHERE ${queuePredicates["confirmed-orders"]}) AS confirmed_orders
    FROM orders o`;
  const params: string[] = [];

  if (currentUser.role === "CONFIRMATION_AGENT") {
    orderQuery += " INNER JOIN campaign_assignments ca ON ca.order_id=o.id";
    orderScope += " INNER JOIN campaign_assignments ca ON ca.order_id=o.id";
    orderCountQuery += " INNER JOIN campaign_assignments ca ON ca.order_id=o.id";
    fulfillmentCountQuery += " INNER JOIN campaign_assignments ca ON ca.order_id=o.id";
    orderQuery += " WHERE ca.assigned_agent_id=?1";
    orderScope += " WHERE ca.assigned_agent_id=?1";
    orderCountQuery += " WHERE ca.assigned_agent_id=?1";
    fulfillmentCountQuery += " WHERE ca.assigned_agent_id=?1";
    params.push(currentUser.id);
  } else if (currentUser.role === "WAREHOUSE") {
    // Warehouse access begins at manifest creation; it must not expose
    // customer-confirmation or pre-ship queues through the raw state API.
    orderQuery += " WHERE o.current_status IN ('MANIFESTED','LABEL_PRINTED','PICKUP_SCHEDULED','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','AUTO_CANCEL_RISK','SHIPMENT_AUTO_CANCELLED','RTO_INITIATED','RTO_IN_TRANSIT','RTO_RECEIVED','RTO_INSPECTION_PENDING','RTO_RESTOCKED','RTO_DAMAGED')";
    orderScope += " WHERE o.current_status IN ('MANIFESTED','LABEL_PRINTED','PICKUP_SCHEDULED','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','AUTO_CANCEL_RISK','SHIPMENT_AUTO_CANCELLED','RTO_INITIATED','RTO_IN_TRANSIT','RTO_RECEIVED','RTO_INSPECTION_PENDING','RTO_RESTOCKED','RTO_DAMAGED')";
    orderCountQuery += " WHERE o.current_status IN ('MANIFESTED','LABEL_PRINTED','PICKUP_SCHEDULED','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','AUTO_CANCEL_RISK','SHIPMENT_AUTO_CANCELLED','RTO_INITIATED','RTO_IN_TRANSIT','RTO_RECEIVED','RTO_INSPECTION_PENDING','RTO_RESTOCKED','RTO_DAMAGED')";
    fulfillmentCountQuery += " WHERE o.current_status IN ('MANIFESTED','LABEL_PRINTED','PICKUP_SCHEDULED','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','AUTO_CANCEL_RISK','SHIPMENT_AUTO_CANCELLED','RTO_INITIATED','RTO_IN_TRANSIT','RTO_RECEIVED','RTO_INSPECTION_PENDING','RTO_RESTOCKED','RTO_DAMAGED')";
  }

  if (fulfillmentQueue !== "all" && fulfillmentQueue !== "campaign-selection") {
    const predicate = queuePredicates[fulfillmentQueue];
    const append = (query: string) => `${query}${/\bWHERE\b/i.test(query) ? " AND " : " WHERE "}${predicate}`;
    orderQuery = append(orderQuery);
    orderScope = append(orderScope);
    orderCountQuery = append(orderCountQuery);
  }

  const orderSortExpression = fulfillmentQueue === "new-orders" || fulfillmentQueue === "campaign-selection"
    ? "o.created_at DESC, o.id DESC"
    : fulfillmentQueue === "shipped"
      ? `${shippedActivityExpression} DESC, o.id DESC`
      : "GREATEST(o.created_at,o.updated_at) DESC, o.id DESC";
  orderScope += safeOrderLimit > 0 ? ` ORDER BY ${orderSortExpression} LIMIT ${safeOrderLimit} OFFSET ${safeOrderOffset}` : ` ORDER BY ${orderSortExpression}`;
  orderQuery += safeOrderLimit > 0 ? ` ORDER BY ${orderSortExpression} LIMIT ${safeOrderLimit} OFFSET ${safeOrderOffset}` : ` ORDER BY ${orderSortExpression}`;
  
  const [orderResult, orderCountResult, fulfillmentCountResult, latestOrderResult, lineResult, tagResult, userResult, productResult, componentResult, componentTypeResult, balanceResult, allocationSummaryResult, manualSaleResult, inventoryLogResult, shipmentEventResult, integrationResult, rtoOrderResult, rtoOrderLineResult, rtoResult, auditResult, requirementResult, requirementSetResult, planResult, recipeResult, recipeItemResult, profileResult, boxResult, campaignAssignmentResult, campaignResult, attemptResult, editRequestResult, cooldownSettingResult, recallOverrideResult, shipmentResult] = await runSnapshotQueries([
    () => db.prepare(orderQuery).bind(...params).all<Row>(),
    () => db.prepare(orderCountQuery).bind(...params).all<Row>(),
    () => db.prepare(fulfillmentCountQuery).bind(...params).all<Row>(),
    () => db.prepare("SELECT MAX(created_at) AS latest_order_at FROM orders").all<Row>(),
    () => db.prepare(`SELECT * FROM order_lines WHERE order_id IN (${orderScope})`).bind(...params).all<Row>(),
    () => db.prepare(`SELECT * FROM order_tags WHERE order_id IN (${orderScope}) ORDER BY tag`).bind(...params).all<Row>(),
    () => db.prepare("SELECT id,email,name,role,active FROM users ORDER BY name").all<Row>(),
    () => db.prepare("SELECT * FROM products WHERE active=1 ORDER BY name").all<Row>(),
    () => db.prepare("SELECT * FROM inventory_components WHERE active=1 ORDER BY name").all<Row>(),
    () => db.prepare("SELECT code,name FROM component_types WHERE active=1 ORDER BY CASE code WHEN 'ACCESSORY' THEN 1 WHEN 'INSERT' THEN 2 WHEN 'INNER_PACKAGING' THEN 3 WHEN 'OUTER_PACKAGING' THEN 4 WHEN 'COURIER_BOX' THEN 5 WHEN 'OTHER' THEN 99 ELSE 6 END,name").all<Row>(),
    () => db.prepare("SELECT component_id,COALESCE(SUM(quantity),0) AS on_hand FROM component_ledger GROUP BY component_id").all<Row>(),
    // Inventory balances must reflect every reservation, not merely the
    // currently visible order page.
    () => db.prepare("SELECT r.component_id,COALESCE(SUM(r.allocated_quantity),0) AS allocated,COALESCE(SUM(CASE WHEN r.source='BOM' AND o.status='rto_in_transit' THEN r.required_quantity ELSE 0 END),0) AS incoming_rto,MIN(CASE WHEN r.source='BOM' AND o.status='rto_in_transit' THEN o.rto_eta ELSE NULL END) AS expected_rto_date FROM order_requirements r JOIN orders o ON o.id=r.order_id GROUP BY r.component_id").all<Row>(),
    () => db.prepare(`SELECT s.*,u.name AS created_by_name FROM manual_sales s LEFT JOIN users u ON u.id=s.created_by ORDER BY s.created_at DESC LIMIT ${INITIAL_ACTIVITY_LIMIT}`).all<Row>(),
    () => db.prepare(`SELECT l.*,c.sku AS component_sku,c.name AS component_name,u.name AS actor_name FROM component_ledger l JOIN inventory_components c ON c.id=l.component_id LEFT JOIN users u ON u.id=l.created_by ORDER BY l.created_at DESC LIMIT ${INITIAL_ACTIVITY_LIMIT}`).all<Row>(),
    // The overview needs recent activity, not the complete webhook archive.
    // Historical events remain available from the paginated order views.
    () => db.prepare(`SELECT * FROM shipment_events ORDER BY occurred_at DESC,received_at DESC LIMIT ${INITIAL_ACTIVITY_LIMIT}`).all<Row>(),
    () => db.prepare("SELECT provider,status,detail,last_synced_at FROM integration_state ORDER BY provider").all<Row>(),
    () => db.prepare(`SELECT o.id,o.order_number,o.customer_name,o.status,o.current_status,o.awb,o.courier,o.rto_eta,o.updated_at FROM orders o WHERE ${RTO_ORDER_PREDICATE} ORDER BY o.updated_at DESC`).all<Row>(),
    () => db.prepare(`SELECT l.id,l.order_id,l.sku,l.name,l.quantity FROM order_lines l WHERE l.order_id IN (SELECT o.id FROM orders o WHERE ${RTO_ORDER_PREDICATE}) ORDER BY l.order_id,l.id`).all<Row>(),
    () => db.prepare(`SELECT r.*,o.order_number,o.customer_name,o.rto_eta FROM rto_tasks r JOIN orders o ON o.id=r.order_id WHERE ${RTO_ORDER_PREDICATE} OR r.status<>'completed' ORDER BY r.created_at DESC`).all<Row>(),
    // Audit history is loaded through /api/audits only when the Audits submenu opens.
    () => db.prepare("SELECT a.*,u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE 1=0").all<Row>(),
    () => db.prepare(`SELECT r.*,c.sku,c.name FROM order_requirements r JOIN inventory_components c ON c.id=r.component_id WHERE r.order_id IN (${orderScope})`).bind(...params).all<Row>(),
    () => db.prepare(`SELECT * FROM order_requirement_sets WHERE order_id IN (${orderScope})`).bind(...params).all<Row>(),
    () => db.prepare(`SELECT * FROM packaging_plans WHERE order_id IN (${orderScope})`).bind(...params).all<Row>(),
    () => db.prepare("SELECT * FROM recipe_versions WHERE status='active'").all<Row>(),
    () => db.prepare("SELECT * FROM recipe_items").all<Row>(),
    () => db.prepare("SELECT * FROM packaging_profiles WHERE active=1 ORDER BY name").all<Row>(),
    () => db.prepare("SELECT b.*,c.name AS component_name,c.sku AS component_sku FROM packaging_box_options b JOIN inventory_components c ON c.id=b.component_id WHERE b.active=1 ORDER BY b.capacity").all<Row>(),
    () => db.prepare("SELECT ca.*,u.name AS assigned_agent_name FROM campaign_assignments ca LEFT JOIN users u ON u.id=ca.assigned_agent_id ORDER BY ca.campaign_id ASC,ca.position ASC,ca.created_at ASC").all<Row>(),
    () => db.prepare("SELECT c.*,u.name AS created_by_name,a.name AS assigned_agent_name FROM campaigns c LEFT JOIN users u ON u.id=c.created_by LEFT JOIN users a ON a.id=c.assigned_agent_id ORDER BY c.position ASC,c.created_at DESC").all<Row>(),
    () => db.prepare(`SELECT a.*,u.name AS user_name FROM confirmation_attempts a LEFT JOIN users u ON u.id=a.user_id WHERE a.order_id IN (${orderScope}) ORDER BY a.created_at ASC`).bind(...params).all<Row>(),
    () => db.prepare(`SELECT r.*,u.name AS requested_by_name FROM order_edit_requests r LEFT JOIN users u ON u.id=r.requested_by WHERE r.order_id IN (${orderScope}) ORDER BY r.created_at DESC`).bind(...params).all<Row>(),
    () => db.prepare("SELECT s.*,u.name AS updated_by_name FROM recall_cooldown_settings s LEFT JOIN users u ON u.id=s.updated_by WHERE s.id='default' LIMIT 1").all<Row>(),
    () => db.prepare("SELECT o.*,ord.order_number,u.name AS overridden_by_name FROM recall_overrides o JOIN orders ord ON ord.id=o.order_id LEFT JOIN users u ON u.id=o.overridden_by ORDER BY o.created_at DESC LIMIT 25").all<Row>(),
    () => db.prepare(`SELECT order_id,manifested_at,picked_up_at,auto_cancel_deadline,courier_auto_cancel_days,status,is_active FROM shipments WHERE is_active=1 AND order_id IN (${orderScope})`).bind(...params).all<Row>(),
  ]);
  const manualCampaignOrderActive = await db.prepare("SELECT 1 AS active FROM audit_events WHERE action='campaign.reordered' LIMIT 1").first<{ active: number }>();
  // Deletion-history checks are needed only when an administrator opens the
  // people controls. Calculating thirteen full-table aggregates on every
  // workspace visit made the overview slow even though it does not show them.
  const userDeleteGuards = new Map();
  const campaignsById = new Map(campaignResult.results.map((row) => [String(row.id), row]));
  const campaignAssignmentByOrder = new Map(campaignAssignmentResult.results.map((row) => [String(row.order_id), row]));
  const attemptsByOrder = new Map<string, Row[]>();
  for (const row of attemptResult.results) attemptsByOrder.set(String(row.order_id), [...(attemptsByOrder.get(String(row.order_id)) ?? []), row]);
  const editRequestsByOrder = new Map<string, Row[]>();
  for (const row of editRequestResult.results) editRequestsByOrder.set(String(row.order_id), [...(editRequestsByOrder.get(String(row.order_id)) ?? []), row]);

  const linesByOrder = new Map<string, Row[]>();
  for (const line of lineResult.results) {
    const orderId = String(line.order_id);
    linesByOrder.set(orderId, [...(linesByOrder.get(orderId) ?? []), line]);
  }
  const tagsByOrder = new Map<string, string[]>();
  for (const row of tagResult.results) {
    const orderId = String(row.order_id);
    tagsByOrder.set(orderId, [...(tagsByOrder.get(orderId) ?? []), String(row.tag)]);
  }

  const requirementSets = new Map(requirementSetResult.results.map((row) => [String(row.order_id), String(row.status)]));
  const plans = new Map(planResult.results.map((row) => [String(row.order_id), String(row.status)]));
  const shipmentByOrder = new Map(shipmentResult.results.map((row) => [String(row.order_id), row]));
  const requirementsByOrder = new Map<string, Row[]>();
  for (const req of requirementResult.results) requirementsByOrder.set(String(req.order_id), [...(requirementsByOrder.get(String(req.order_id)) ?? []), req]);
  const groupedOrderRows = orderResult.results.reduce((byNumber, row) => {
    const key = String(row.order_number).replace(/^#/, "").toUpperCase();
    byNumber.set(key, [...(byNumber.get(key) ?? []), row]);
    return byNumber;
  }, new Map<string, Row[]>());
  const orderAliases = new Map<string, string[]>();
  const dedupedOrderRows = [...groupedOrderRows.values()].map((rows) => {
    const canonical = rows.find((row) => row.shopify_order_id) ?? rows[0];
    const logistics = rows.find((row) => row.shiprocket_order_id && (row.awb || !["", "new", "pending", "open"].includes(String(row.tracking_status || "").toLowerCase())))
      ?? rows.find((row) => row.shiprocket_order_id);
    const logisticsProgressed = Boolean(logistics && (logistics.awb || !["", "new", "pending", "open"].includes(String(logistics.tracking_status || "").toLowerCase())));
    orderAliases.set(String(canonical.id), [String(canonical.id), ...rows.filter((row) => row.id !== canonical.id).map((row) => String(row.id))]);
    if (!logistics || logistics.id === canonical.id) return canonical;
    return {
      ...canonical,
      shiprocket_order_id: canonical.shiprocket_order_id || logistics.shiprocket_order_id,
      shipment_id: canonical.shipment_id || logistics.shipment_id,
      awb: canonical.awb || logistics.awb,
      courier: canonical.courier || logistics.courier,
      tracking_status: logistics.tracking_status || canonical.tracking_status,
      rto_eta: canonical.rto_eta || logistics.rto_eta,
      status: logisticsProgressed ? logistics.status : canonical.status,
      current_status: logisticsProgressed ? logistics.current_status : canonical.current_status,
      updated_at: [canonical.updated_at, logistics.updated_at].filter(Boolean).sort().at(-1) ?? canonical.updated_at,
      latest_shipment_event_at: [canonical.latest_shipment_event_at, logistics.latest_shipment_event_at].filter(Boolean).sort().at(-1) ?? canonical.latest_shipment_event_at,
    };
  });
  const orders: OrderView[] = dedupedOrderRows.map((row) => {
    const aliasIds = orderAliases.get(String(row.id)) ?? [String(row.id)];
    const requirementRows = aliasIds.map((id) => requirementsByOrder.get(id) ?? []).find((items) => items.length) ?? [];
    const shipment = aliasIds.map((id) => shipmentByOrder.get(id)).find(Boolean);
    const assignment = aliasIds.map((id) => campaignAssignmentByOrder.get(id)).find(Boolean) ?? null;
    const campaign = assignment ? campaignsById.get(String(assignment.campaign_id)) ?? null : null;
    const campaignCriteria = campaign ? parseCampaignCriteria(campaign.criteria_json) : null;
    const attemptRows = aliasIds.flatMap((id) => attemptsByOrder.get(id) ?? []).sort((a, b) => num(a.attempt_number) - num(b.attempt_number) || String(a.created_at).localeCompare(String(b.created_at)));
    const pendingEditRows = aliasIds.flatMap((id) => editRequestsByOrder.get(id) ?? []).filter((request) => String(request.status) === "PENDING");
    const lineRows = aliasIds.map((id) => linesByOrder.get(id) ?? []).find((items) => items.length) ?? [];
    const requirements = requirementRows.map((req) => ({ id: String(req.id), orderLineId: req.order_line_id ? String(req.order_line_id) : null, componentId: String(req.component_id), sku: String(req.sku), name: String(req.name), source: String(req.source) as "BOM" | "COURIER_BOX", requiredQuantity: num(req.required_quantity), allocatedQuantity: num(req.allocated_quantity), missingQuantity: Math.max(0, num(req.required_quantity) - num(req.allocated_quantity)) }));
    const shortages = requirements.filter((item) => item.missingQuantity > 0);
    const customerAddress = [
      row.shipping_address ? String(row.shipping_address).trim() : "",
      row.shipping_city ? String(row.shipping_city).trim() : "",
      row.shipping_state ? String(row.shipping_state).trim() : "",
      row.shipping_pincode ? String(row.shipping_pincode).trim() : "",
      row.shipping_country ? String(row.shipping_country).trim() : "",
    ].filter(Boolean).join(", ");
    const base = {
      id: String(row.id), shopifyCustomerId: row.shopify_customer_id ? String(row.shopify_customer_id) : null, orderNumber: String(row.order_number), customerName: String(row.customer_name), customerPhone: row.customer_phone ? String(row.customer_phone) : null,
      customerAddress: customerAddress || null,
      shopifyTags: [...new Set(aliasIds.flatMap((id) => tagsByOrder.get(id) ?? []))],
      paymentMethod: String(row.payment_method), amount: num(row.amount), status: String(row.status), currentStatus: String(row.current_status || "INGESTED"), rtoRisk: row.rto_risk ? String(row.rto_risk) : null, rtoScore: row.rto_score === null || row.rto_score === undefined ? null : num(row.rto_score), confirmationSelected: bool(row.confirmation_selected),
      confirmationStatus: String(row.confirmation_status), assignedUserId: row.assigned_user_id ? String(row.assigned_user_id) : null,
      assignedUserName: row.assigned_user_name ? String(row.assigned_user_name) : null, shiprocketOrderId: row.shiprocket_order_id ? String(row.shiprocket_order_id) : null,
      shipmentId: row.shipment_id ? String(row.shipment_id) : null,
      manifestedAt: shipment?.manifested_at ? String(shipment.manifested_at) : null,
      pickedUpAt: shipment?.picked_up_at ? String(shipment.picked_up_at) : null,
      latestShipmentEventAt: row.latest_shipment_event_at ? String(row.latest_shipment_event_at) : null,
      autoCancelDeadline: shipment?.auto_cancel_deadline ? String(shipment.auto_cancel_deadline) : null,
      courierAutoCancelDays: shipment?.courier_auto_cancel_days === null || shipment?.courier_auto_cancel_days === undefined ? null : num(shipment.courier_auto_cancel_days),
      awb: row.awb ? String(row.awb) : null, courier: row.courier ? String(row.courier) : null, trackingStatus: row.tracking_status ? String(row.tracking_status) : null,
      cancellationSource: row.cancellation_source ? String(row.cancellation_source) : null, cancellationReason: row.cancellation_reason ? String(row.cancellation_reason) : null,
      cancelledBy: row.cancelled_by ? String(row.cancelled_by) : null, cancelledAt: row.cancelled_at ? String(row.cancelled_at) : null,
      labelKey: row.label_key ? String(row.label_key) : null, warehouseAcknowledged: bool(row.warehouse_acknowledged), rtoEta: row.rto_eta ? String(row.rto_eta) : null,
      stuckReason: row.stuck_reason ? String(row.stuck_reason) : null, stuckNotes: row.stuck_notes ? String(row.stuck_notes) : null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      lines: lineRows.map((line) => ({ id: String(line.id), productId: line.product_id ? String(line.product_id) : null, sku: String(line.sku), name: String(line.name), quantity: num(line.quantity), allocatedQuantity: num(line.allocated_quantity) })),
      requirementStatus: (requirementSets.get(String(row.id)) ?? null) as OrderView["requirementStatus"], packagingPlanStatus: plans.get(String(row.id)) ?? null, requirements,
      shortageSummary: shortages.length ? shortages.slice(0, 2).map((item) => `${item.name} −${item.missingQuantity}`).join(", ") : null,
      assignedCampaign: assignment && campaign ? { id: String(campaign.id), name: String(campaign.name), urgency: String(campaign.urgency) as CampaignUrgency, assignedAgentId: String(assignment.assigned_agent_id), assignedAgentName: assignment.assigned_agent_name ? String(assignment.assigned_agent_name) : null, createdAt: String(assignment.created_at), position: num(campaign.position), orderPosition: num(assignment.position), criteria: campaignCriteria } : null,
      confirmationAttempts: attemptRows.map((attempt) => ({ id: String(attempt.id), attemptNumber: num(attempt.attempt_number), outcome: String(attempt.outcome), callPicked: bool(attempt.call_picked), rejectionReason: attempt.rejection_reason ? String(attempt.rejection_reason) as OrderView["confirmationAttempts"][number]["rejectionReason"] : null, note: attempt.note ? String(attempt.note) : null, callbackAt: attempt.callback_at ? String(attempt.callback_at) : null, nextActionAt: attempt.next_action_at ? String(attempt.next_action_at) : null, createdAt: String(attempt.created_at), userId: String(attempt.user_id), userName: attempt.user_name ? String(attempt.user_name) : null })),
      pendingEditRequests: pendingEditRows.map((request) => ({ id: String(request.id), fieldName: String(request.field_name), oldValue: request.old_value ? String(request.old_value) : null, newValue: String(request.new_value), createdAt: String(request.created_at), requestedBy: String(request.requested_by), requestedByName: request.requested_by_name ? String(request.requested_by_name) : null, status: String(request.status) as "PENDING" | "APPROVED" | "REJECTED" })),
    };
    const blocker = deriveBlocker(base);
    return { ...base, blocker, processed: isProcessed(base) };
  });

  const balances = new Map(balanceResult.results.map((row) => [String(row.component_id), num(row.on_hand)]));
  const allocationSummaries = new Map(allocationSummaryResult.results.map((row) => [String(row.component_id), row]));
  const inventory: InventoryView[] = componentResult.results.map((component) => {
    const allocationSummary = allocationSummaries.get(String(component.id));
    const allocated = num(allocationSummary?.allocated);
    const requiredBy = recipeItemResult.results.filter((item) => item.component_id === component.id).flatMap((item) => {
      const recipe = recipeResult.results.find((row) => row.id === item.recipe_version_id);
      const product = recipe ? productResult.results.find((row) => row.id === recipe.product_id) : null;
      return product ? [{ productId: String(product.id), productName: String(product.name), productSku: String(product.sku), quantity: num(item.quantity) }] : [];
    });
    return {
      id: String(component.id), sku: String(component.sku), name: String(component.name), variant: String(component.component_type).replaceAll("_", " "), componentType: String(component.component_type) as InventoryView["componentType"], unit: String(component.unit), rtoRecoverable: bool(component.rto_recoverable), onHand: balances.get(String(component.id)) ?? 0,
      allocated, available: inventoryAvailability(balances.get(String(component.id)) ?? 0, allocated), incomingRto: bool(component.rto_recoverable) && component.component_type !== "COURIER_BOX" ? num(allocationSummary?.incoming_rto) : 0,
      expectedRtoDate: allocationSummary?.expected_rto_date ? String(allocationSummary.expected_rto_date) : null,
      requiredBy,
    };
  });

  const rtoLinesByOrder = new Map<string, Row[]>();
  for (const line of rtoOrderLineResult.results) rtoLinesByOrder.set(String(line.order_id), [...(rtoLinesByOrder.get(String(line.order_id)) ?? []), line]);
  const rtoOrders: RtoOrderView[] = rtoOrderResult.results.map((row) => ({
    id: String(row.id), orderNumber: String(row.order_number), customerName: String(row.customer_name), status: String(row.status), currentStatus: String(row.current_status || "RTO_INITIATED"), awb: row.awb ? String(row.awb) : null, courier: row.courier ? String(row.courier) : null, eta: validDateValue(row.rto_eta), updatedAt: validDateValue(row.updated_at) ?? new Date(0).toISOString(),
    lines: (rtoLinesByOrder.get(String(row.id)) ?? []).map((line) => ({ id: String(line.id), sku: String(line.sku), name: String(line.name), quantity: num(line.quantity) })),
  }));
  const rtoTasks: RtoTaskView[] = rtoResult.results.map((row) => {
    const lines = rtoLinesByOrder.get(String(row.order_id)) ?? [];
    return { id: String(row.id), orderId: String(row.order_id), orderNumber: String(row.order_number), customerName: String(row.customer_name), units: lines.reduce((sum, line) => sum + num(line.quantity), 0), status: String(row.status), eta: validDateValue(row.rto_eta), outcome: row.outcome ? String(row.outcome) : null, lines: lines.map((line) => ({ id: String(line.id), name: String(line.name), sku: String(line.sku), quantity: num(line.quantity), hasSnapshot: requirementResult.results.some((req) => req.order_line_id === line.id && req.source === "BOM") })) };
  });

  const blockerLabels: Record<string, string> = { "invalid-SKU": "SKU mapping missing", "recipe-missing": "Recipe not configured", "packaging-plan-required": "Packaging decision required", "component-shortage": "Component shortage", "confirmation-pending": "Confirmation pending", "Shiprocket-missing": "Shiprocket sync pending", "AWB-missing": "AWB missing", "label-missing": "Label missing", "integration-error": "Integration error" };
  const blockers = Object.entries(blockerLabels).map(([key, label]) => ({ key, label, count: orders.filter((order) => order.blocker === key).length })).filter((item) => item.count > 0);
  const activeOrders = orders.filter((order) => !["cancelled", "delivered", "rto_delivered"].includes(order.status));
  const cooldownSetting = cooldownSettingResult.results[0] ?? null;
  const reviewer = ["ADMIN", "MANAGER"].includes(currentUser.role);
  const latestOrderAt = latestOrderResult.results[0]?.latest_order_at ? String(latestOrderResult.results[0].latest_order_at) : null;
  const latestOrderAgeHours = latestOrderAt ? Math.max(0, Math.floor((Date.now() - new Date(latestOrderAt).getTime()) / 3_600_000)) : null;

  return {
    currentUser,
    generatedAt: new Date().toISOString(),
    campaignManualOrderActive: Boolean(manualCampaignOrderActive?.active),
    metrics: {
      processedToday: activeOrders.filter((order) => order.processed).length,
      leftToProcess: activeOrders.filter((order) => !order.processed).length,
      confirmationBacklog: activeOrders.filter((order) => order.blocker === "confirmation-pending").length,
      inventoryShortages: activeOrders.filter((order) => order.blocker === "component-shortage").length,
      delivered: orders.filter((order) => order.status === "delivered").length,
      rtoUnits: orders.filter((order) => order.status === "rto_in_transit").flatMap((order) => order.lines).reduce((sum, line) => sum + line.quantity, 0),
    },
    blockers,
    orders,
    orderPagination: {
      limit: safeOrderLimit,
      nextOffset: safeOrderOffset + orderResult.results.length,
      total: num(orderCountResult.results[0]?.count),
      hasMore: safeOrderLimit > 0 && safeOrderOffset + orderResult.results.length < num(orderCountResult.results[0]?.count),
    },
    fulfillmentCounts: { total: num(fulfillmentCountResult.results[0]?.total), newOrders: num(fulfillmentCountResult.results[0]?.new_orders), labelsGenerated: num(fulfillmentCountResult.results[0]?.labels_generated), shipped: num(fulfillmentCountResult.results[0]?.shipped), confirmedOrders: num(fulfillmentCountResult.results[0]?.confirmed_orders) },
    inventory, rtoTasks, rtoOrders,
    componentTypes: componentTypeResult.results.map((row) => ({ code: String(row.code), name: String(row.name) })),
    users: userResult.results.map((row) => ({ id: String(row.id), email: String(row.email), name: String(row.name), role: String(row.role) as AppUser["role"], active: bool(row.active), deleteInfo: getUserDeleteGuard(userDeleteGuards, String(row.id)) })),
    integrations: integrationResult.results.map((row) => ({ provider: String(row.provider), status: String(row.status), detail: row.detail ? String(row.detail) : null, lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null })),
    orderFreshness: { latestOrderAt, ageHours: latestOrderAgeHours },
    recentAudit: auditResult.results.map((row) => ({ id: String(row.id), action: String(row.action), detail: row.detail ? String(row.detail) : null, createdAt: String(row.created_at), actorName: row.actor_name ? String(row.actor_name) : null })),
    sampleMode: (getEnv().APP_MODE || "live") === "sample",
    products: productResult.results.map((product) => {
      const recipe = recipeResult.results.find((row) => row.product_id === product.id); const items = recipe ? recipeItemResult.results.filter((row) => row.recipe_version_id === recipe.id) : [];
      const buildable = items.length ? Math.min(...items.map((item) => Math.floor(Math.max(0, balances.get(String(item.component_id)) ?? 0) / Math.max(1, num(item.quantity))))) : 0;
      return { id: String(product.id), sku: String(product.sku), name: String(product.name), variant: String(product.variant), recipeVersion: recipe ? num(recipe.version) : null, recipeId: recipe ? String(recipe.id) : null, packagingProfileId: recipe ? String(recipe.packaging_profile_id) : null, packingUnits: recipe ? num(recipe.packing_units) : 1, recipeItems: items.map((item) => ({ componentId: String(item.component_id), quantity: num(item.quantity) })), buildableUnits: buildable, shopifyVariantId: product.shopify_variant_id ? String(product.shopify_variant_id) : null, isManual: Boolean(!product.shopify_variant_id && String(product.id).startsWith("prd_manual_")) };
    }),
    packagingProfiles: profileResult.results.map((profile) => ({ id: String(profile.id), name: String(profile.name), boxes: boxResult.results.filter((box) => box.profile_id === profile.id).map((box) => ({ id: String(box.id), componentId: String(box.component_id), componentName: String(box.component_name), componentSku: String(box.component_sku), capacity: num(box.capacity) })) })),
    manualSales: manualSaleResult.results.map((sale) => ({ id: String(sale.id), reference: String(sale.reference), productId: String(sale.product_id), productSku: String(sale.product_sku), productName: String(sale.product_name), quantity: num(sale.quantity), status: String(sale.status) as "dispatched" | "delivered" | "rto", createdByName: sale.created_by_name ? String(sale.created_by_name) : null, createdAt: String(sale.created_at), updatedAt: String(sale.updated_at) })),
    inventoryLog: inventoryLogResult.results
      .filter((entry) => !inventoryLogVisibleFrom || String(entry.created_at) >= inventoryLogVisibleFrom)
      .map((entry) => ({ id: String(entry.id), componentId: String(entry.component_id), componentSku: String(entry.component_sku), componentName: String(entry.component_name), movementType: String(entry.movement_type), quantity: num(entry.quantity), reason: String(entry.reason), actorName: entry.actor_name ? String(entry.actor_name) : null, createdAt: String(entry.created_at) })),
    shipmentEvents: shipmentEventResult.results.map((entry) => ({
      id: String(entry.id), orderId: entry.order_id ? String(entry.order_id) : null, awb: String(entry.awb), status: String(entry.status),
      statusCode: entry.status_code ? String(entry.status_code) : null, courier: entry.courier ? String(entry.courier) : null,
      occurredAt: String(entry.occurred_at), receivedAt: String(entry.received_at),
    })),
    campaigns: campaignResult.results.map((campaign) => ({ id: String(campaign.id), name: String(campaign.name), description: campaign.description ? String(campaign.description) : null, urgency: String(campaign.urgency) as CampaignUrgency, assignedAgentId: String(campaign.assigned_agent_id), assignedAgentName: campaign.assigned_agent_name ? String(campaign.assigned_agent_name) : null, criteria: parseCampaignCriteria(campaign.criteria_json), position: num(campaign.position), isActive: bool(campaign.is_active), createdAt: String(campaign.created_at), createdByName: campaign.created_by_name ? String(campaign.created_by_name) : null, assignedOrders: campaignAssignmentResult.results.filter((assignment) => String(assignment.campaign_id) === String(campaign.id)).length })),
    pendingEditRequests: reviewer ? editRequestResult.results
      .filter((request) => String(request.status) === "PENDING")
      .map((request) => {
        const order = orders.find((item) => item.id === String(request.order_id));
        return {
          id: String(request.id),
          orderId: String(request.order_id),
          orderNumber: order?.orderNumber ?? String(request.order_id),
          customerName: order?.customerName ?? "Unknown customer",
          fieldName: String(request.field_name),
          oldValue: request.old_value ? String(request.old_value) : null,
          newValue: String(request.new_value),
          createdAt: String(request.created_at),
          requestedBy: String(request.requested_by),
          requestedByName: request.requested_by_name ? String(request.requested_by_name) : null,
          status: String(request.status) as "PENDING" | "APPROVED" | "REJECTED",
        };
      }) : [],
    recallCooldownSettings: {
      defaultHours: cooldownSetting ? num(cooldownSetting.default_hours) : 24,
      updatedAt: cooldownSetting?.updated_at ? String(cooldownSetting.updated_at) : null,
      updatedByName: cooldownSetting?.updated_by_name ? String(cooldownSetting.updated_by_name) : null,
    },
    recallOverrides: reviewer ? recallOverrideResult.results.map((entry) => ({
      id: String(entry.id),
      orderId: String(entry.order_id),
      orderNumber: String(entry.order_number),
      overriddenByName: entry.overridden_by_name ? String(entry.overridden_by_name) : null,
      reason: String(entry.reason),
      originalNextActionAt: entry.original_next_action_at ? String(entry.original_next_action_at) : null,
      newNextActionAt: String(entry.new_next_action_at),
      createdAt: String(entry.created_at),
    })) : [],
  };
}

export async function mutateOrder(actor: AppUser, orderId: string, action: string, payload: Record<string, unknown>) {
  await ensureDatabase();
  const db = getEnv().DB;
  const now = new Date().toISOString();
  if (action === "outcome") {
    const outcome = String(payload.outcome);
    const note = String(payload.note || "").trim();
    const callbackAt = payload.callbackAt ? String(payload.callbackAt) : null;
    const callPicked = payload.callPicked === undefined ? outcome !== "unreachable" : Boolean(payload.callPicked);
    const rejectionReason = payload.rejectionReason ? String(payload.rejectionReason) : null;
    const privilegedApprover = ["ADMIN", "MANAGER"].includes(actor.role);
    const latestAttempt = await db.prepare("SELECT attempt_number,next_action_at FROM confirmation_attempts WHERE order_id=?1 ORDER BY attempt_number DESC,created_at DESC LIMIT 1").bind(orderId).first<Row>();
    const cooldownSetting = await db.prepare("SELECT default_hours FROM recall_cooldown_settings WHERE id='default' LIMIT 1").first<Row>();
    const defaultCooldownHours = Math.max(1, num(cooldownSetting?.default_hours || 24));
    const coolingUntil = latestAttempt?.next_action_at ? new Date(String(latestAttempt.next_action_at)) : null;
    const recallLocked = Boolean(coolingUntil && coolingUntil.getTime() > Date.now());
    const reviewOutcome = ["cancelled", "cancel-rejected"].includes(outcome);
    if (recallLocked && !privilegedApprover && !reviewOutcome) throw new Error(`Recall is cooling down until ${coolingUntil?.toLocaleString("en-IN")}`);
    if (["confirmed", "cancelled", "cancel-requested"].includes(outcome) && !note) throw new Error("Call note is required to confirm or cancel an order");
    if (actor.role === "CONFIRMATION_AGENT" && outcome === "cancelled") throw new Error("Confirmation agents must send cancellation requests to a manager or admin for approval");
    const existingAttempts = await db.prepare("SELECT COUNT(*) AS count FROM confirmation_attempts WHERE order_id=?1").bind(orderId).first<{ count: number }>();
    const attemptNumber = Number(existingAttempts?.count ?? 0) + 1;
    if (attemptNumber > 3) throw new Error("Only Recall 1, Recall 2, and Recall 3 are allowed for a confirmation order");
    const requestedNextActionAt = payload.nextActionAt ? String(payload.nextActionAt) : callbackAt;
    const nextActionAt = ["callback", "unreachable"].includes(outcome)
      ? (requestedNextActionAt || new Date(Date.now() + defaultCooldownHours * 3_600_000).toISOString())
      : requestedNextActionAt;

    let updateStatement;
    if (outcome === "cancel-requested") {
      updateStatement = db.prepare(`UPDATE orders
        SET confirmation_selected=1,
            confirmation_status='cancel-requested',
            cancellation_source='Cancellation approval pending',
            cancellation_reason=?1,
            cancelled_by=?2,
            cancelled_at=NULL,
            updated_at=?3
        WHERE id=?4`).bind(note, actor.name, now, orderId);
    } else if (outcome === "cancel-rejected") {
      updateStatement = db.prepare(`UPDATE orders
        SET confirmation_status=CASE
              WHEN assigned_user_id IS NOT NULL THEN 'assigned'
              WHEN confirmation_selected=1 THEN 'selected'
              ELSE 'not-required'
            END,
            cancellation_source=NULL,
            cancellation_reason=NULL,
            cancelled_by=NULL,
            cancelled_at=NULL,
            updated_at=?1
        WHERE id=?2`).bind(now, orderId);
    } else if (outcome === "cancelled") {
      if (!privilegedApprover) throw new Error("Only a manager or admin can approve a cancellation");
      updateStatement = db.prepare(`UPDATE orders
        SET confirmation_status='cancelled',
            status='cancelled',
            cancellation_source='Satmi panel',
            cancellation_reason=?1,
            cancelled_by=?2,
            cancelled_at=?3,
            updated_at=?3
        WHERE id=?4`).bind(note, actor.name, now, orderId);
    } else if (outcome === "confirmed") {
      updateStatement = db.prepare(`UPDATE orders
        SET confirmation_status='confirmed',
            cancellation_source=NULL,
            cancellation_reason=NULL,
            cancelled_by=NULL,
            cancelled_at=NULL,
            updated_at=?1
        WHERE id=?2`).bind(now, orderId);
    } else {
      updateStatement = db.prepare("UPDATE orders SET confirmation_status=?1,updated_at=?2 WHERE id=?3").bind(outcome, now, orderId);
    }

    await db.batch([
      updateStatement,
      db.prepare("INSERT INTO confirmation_attempts (id,order_id,user_id,attempt_number,outcome,call_picked,rejection_reason,note,callback_at,next_action_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)").bind(`att_${randomHex(8)}`, orderId, actor.id, attemptNumber, outcome, callPicked ? 1 : 0, rejectionReason, note, callbackAt, nextActionAt, now),
    ]);
    if (outcome === "cancelled") {
      const requirements = await db.prepare("SELECT id,component_id,allocated_quantity FROM order_requirements WHERE order_id=?1 AND allocated_quantity>0").bind(orderId).all<Row>();
      const releaseStatements = requirements.results.flatMap((req) => [
        db.prepare("INSERT INTO component_ledger(id,component_id,movement_type,quantity,reference_type,reference_id,reason,created_by,created_at) VALUES(?1,?2,'cancellation-release',0,'requirement',?3,?4,?5,?6) ON CONFLICT(id) DO NOTHING").bind(`release_${req.id}`, req.component_id, req.id, `Released ${req.allocated_quantity} reserved unit(s)`, actor.id, now),
        db.prepare("UPDATE order_requirements SET allocated_quantity=0 WHERE id=?1").bind(req.id),
      ]);
      if (releaseStatements.length) await db.batch(releaseStatements);
      await reallocateComponents();
    }
  } else if (action === "request-edit") {
    const fieldName = String(payload.fieldName || "");
    const newValue = String(payload.newValue || "").trim();
    const allowedFields = new Set(["customer_name", "customer_phone", "shipping_address"]);
    if (!allowedFields.has(fieldName)) throw new Error("That field cannot be edited from confirmation");
    if (!newValue) throw new Error("Enter the updated value before requesting approval");
    const order = await db.prepare("SELECT customer_name,customer_phone,shipping_address,shipping_city,shipping_state,shipping_pincode,shipping_country FROM orders WHERE id=?1").bind(orderId).first<Row>();
    if (!order) throw new Error("Order not found");
    const oldValue = fieldName === "customer_name"
      ? String(order.customer_name ?? "").trim()
      : fieldName === "customer_phone"
        ? String(order.customer_phone ?? "").trim()
        : [
            order.shipping_address ? String(order.shipping_address).trim() : "",
            order.shipping_city ? String(order.shipping_city).trim() : "",
            order.shipping_state ? String(order.shipping_state).trim() : "",
            order.shipping_pincode ? String(order.shipping_pincode).trim() : "",
            order.shipping_country ? String(order.shipping_country).trim() : "",
          ].filter(Boolean).join(", ");
    if (oldValue === newValue) throw new Error("The updated value matches the current order value");
    const existingPending = await db.prepare("SELECT id FROM order_edit_requests WHERE order_id=?1 AND field_name=?2 AND status='PENDING' LIMIT 1").bind(orderId, fieldName).first<Row>();
    if (existingPending) throw new Error("A pending approval request already exists for this field");
    await db.prepare("INSERT INTO order_edit_requests (id,order_id,requested_by,field_name,old_value,new_value,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,'PENDING',?7)")
      .bind(`oer_${randomHex(8)}`, orderId, actor.id, fieldName, oldValue || null, newValue, now).run();
  } else if (action === "warehouse-ack") {
    await db.prepare("UPDATE orders SET warehouse_acknowledged=1,updated_at=?1 WHERE id=?2").bind(now, orderId).run();
  } else if (action === "sample-shiprocket") {
    await db.prepare("UPDATE orders SET shiprocket_order_id=?1,shipment_id=?2,awb=?3,courier=?4,tracking_status='ready_to_ship',updated_at=?5 WHERE id=?6")
      .bind(`78${Math.floor(Math.random() * 9_000_000)}`, `SHP-${Math.floor(Math.random() * 90_000)}`, `14322${Math.floor(Math.random() * 90_000_000)}`, "Delhivery", now, orderId).run();
  } else if (action === "fetch-label") {
    const { fetchShiprocketLabel } = await import("./integrations");
    await fetchShiprocketLabel(orderId, actor.id);
  } else if (action === "manifest") {
    const { manifestOrderToShiprocket } = await import("./integrations");
    await manifestOrderToShiprocket(orderId, actor.id);
  } else {
    throw new Error("Unsupported order action");
  }
  await audit(actor.id, `order.${action}`, "order", orderId, String(payload.note || action));
}

export async function applyShipmentTransition(orderId: string, actorId: string | null = null) {
  await ensureDatabase();
  const db = getEnv().DB;
  const lines = await db.prepare("SELECT id,component_id,required_quantity FROM order_requirements WHERE order_id=?1").bind(orderId).all<Row>();
  const now = new Date().toISOString();
  const statements = lines.results.flatMap((line) => [
    db.prepare("INSERT INTO component_ledger(id,component_id,movement_type,quantity,reference_type,reference_id,reason,created_by,created_at) VALUES(?1,?2,'shipment',?3,'requirement',?4,'Component deducted at first carrier pickup',?5,?6) ON CONFLICT(id) DO NOTHING").bind(`shipment_${line.id}`, line.component_id, -num(line.required_quantity), line.id, actorId, now),
    db.prepare("UPDATE order_requirements SET allocated_quantity=0 WHERE id=?1").bind(line.id),
  ]);
  if (statements.length) await db.batch(statements);
  try { await reallocateComponents(); }
  catch (reallocErr) { console.warn("Concurrent reallocation deferred:", reallocErr); }
}

export async function assignCampaign(actor: AppUser, payload: { campaignId?: string; name?: string; description?: string; urgency?: CampaignUrgency; assignedAgentId?: string; orderIds?: string[]; criteria?: CampaignCriteria | null }) {
  await ensureDatabase();
  const db = getEnv().DB;
  const orderIds = [...new Set((payload.orderIds ?? []).map((value) => String(value)).filter(Boolean))];
  if (!["ADMIN", "MANAGER"].includes(actor.role)) throw new Error("Only admin and manager can assign confirmation campaigns");
  const longTerm = Boolean(payload.criteria?.autoAssignFutureMatching);
  if (!orderIds.length && !longTerm) throw new Error("Select at least one order to assign");
  if (longTerm && !payload.criteria?.tags.length) throw new Error("Choose at least one Shopify tag for a long-term campaign");

  let campaignId = payload.campaignId ? String(payload.campaignId) : "";
  const now = new Date().toISOString();
  let assignedAgentId = String(payload.assignedAgentId ?? "").trim();
  let agent: Row | null = null;
  if (!campaignId) {
    const name = String(payload.name ?? "").trim();
    if (!assignedAgentId) throw new Error("Choose a confirmation agent");
    if (!name) throw new Error("Campaign name is required");
    agent = await db.prepare("SELECT id,role,active,name FROM users WHERE id=?1").bind(assignedAgentId).first<Row>();
    if (!agent || String(agent.role) !== "CONFIRMATION_AGENT" || !bool(agent.active)) throw new Error("Choose an active confirmation agent");
    campaignId = `cmp_${randomHex(8)}`;
    // Campaign rank is intentionally determined only by the board's drag order.
    // New campaigns begin at the end; the durable High RTO campaign is seeded at
    // the top once and retains any later manual placement.
    const existingCampaigns = await db.prepare("SELECT id FROM campaigns WHERE is_active=1").all<Row>();
    const position = existingCampaigns.results.length;
    await db.prepare("INSERT INTO campaigns (id,name,description,urgency,assigned_agent_id,criteria_json,position,created_by,created_at,is_active) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1)")
      .bind(campaignId, name, String(payload.description ?? "").trim() || null, "MEDIUM", assignedAgentId, stringifyCampaignCriteria(payload.criteria), position, actor.id, now).run();
  } else {
    const campaign = await db.prepare("SELECT id,is_active,assigned_agent_id FROM campaigns WHERE id=?1").bind(campaignId).first<Row>();
    if (!campaign || !bool(campaign.is_active)) throw new Error("Choose an active campaign");
    assignedAgentId = String(campaign.assigned_agent_id);
    if (payload.assignedAgentId && payload.assignedAgentId !== assignedAgentId) throw new Error("Existing campaigns keep their assigned confirmation agent");
    agent = await db.prepare("SELECT id,role,active,name FROM users WHERE id=?1").bind(assignedAgentId).first<Row>();
    if (!agent || String(agent.role) !== "CONFIRMATION_AGENT" || !bool(agent.active)) throw new Error("Choose an active confirmation agent");
  }

  if (orderIds.length) {
    const placeholders = orderIds.map((_, index) => `?${index + 1}`).join(",");
    const orders = await db.prepare(`SELECT id,order_number,status FROM orders WHERE id IN (${placeholders})`).bind(...orderIds).all<Row>();
    if (orders.results.length !== orderIds.length) throw new Error("One or more selected orders could not be found");
    const blocked = orders.results.find((order) => ["cancelled", "delivered", "rto_delivered"].includes(String(order.status)));
    if (blocked) throw new Error(`Order ${String(blocked.order_number)} cannot be assigned to confirmation`);
  }

  const existingPositions = await db.prepare("SELECT COALESCE(MAX(position), -1) AS max_position FROM campaign_assignments WHERE campaign_id=?1").bind(campaignId).first<{ max_position: number }>();
  const startPosition = Number(existingPositions?.max_position ?? -1) + 1;
  const statements = orderIds.flatMap((orderId, index) => ([
    db.prepare("DELETE FROM campaign_assignments WHERE order_id=?1").bind(orderId),
    db.prepare("INSERT INTO campaign_assignments (id,campaign_id,order_id,assigned_agent_id,position,created_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(`cma_${randomHex(8)}`, campaignId, orderId, assignedAgentId, startPosition + index, now),
    db.prepare("UPDATE orders SET confirmation_selected=1,confirmation_status='assigned',assigned_user_id=?1,updated_at=?2 WHERE id=?3").bind(assignedAgentId, now, orderId),
  ]));
  await db.batch(statements);
  await audit(actor.id, "campaign.assigned", "campaign", campaignId, `${orderIds.length} order(s) assigned to ${String(agent?.name)}`);
  for (const orderId of orderIds) await broadcastOrderUpdate(orderId, "campaign.assigned");
  return { campaignId, assigned: orderIds.length };
}

/** Assign an incoming Shopify order to the highest-priority matching long-term campaign. */
export async function assignOrderToLongTermCampaign(orderId: string) {
  await ensureDatabase();
  const db = getEnv().DB;
  const order = await db.prepare("SELECT id,status FROM orders WHERE id=?1").bind(orderId).first<Row>();
  if (!order || ["cancelled", "delivered", "rto_delivered"].includes(String(order.status))) return null;
  const tags = await db.prepare("SELECT tag FROM order_tags WHERE order_id=?1").bind(orderId).all<Row>();
  const orderTags = new Set(tags.results.map((row) => String(row.tag).trim().toLowerCase()).filter(Boolean));
  if (!orderTags.size) return null;
  const highRtoTags = new Set(["high", "rto_prediction_high"]);
  const isHighRto = [...orderTags].some((tag) => highRtoTags.has(tag));
  const existing = await db.prepare("SELECT id,campaign_id FROM campaign_assignments WHERE order_id=?1 LIMIT 1").bind(orderId).first<Row>();
  // High-RTO routing is a safety rule, not a best-effort long-term filter.
  // It deliberately replaces a previous assignment so these tagged orders
  // always enter the confirmation queue owned by the default campaign.
  if (existing && !isHighRto) return null;
  const campaigns = await db.prepare("SELECT id,assigned_agent_id,criteria_json,position FROM campaigns WHERE is_active=1 ORDER BY position ASC,created_at ASC").all<Row>();
  const campaign = (isHighRto
    ? campaigns.results.find((candidate) => String(candidate.id) === "cmp_default_high_rto")
    : campaigns.results.find((candidate) => {
    const criteria = parseCampaignCriteria(candidate.criteria_json);
    return Boolean(criteria?.autoAssignFutureMatching && criteria.tags.length && criteria.tags.every((tag) => orderTags.has(tag.trim().toLowerCase())));
  }));
  if (!campaign) return null;
  const agent = await db.prepare("SELECT id FROM users WHERE id=?1 AND role='CONFIRMATION_AGENT' AND active=1").bind(campaign.assigned_agent_id).first<Row>();
  if (!agent) return null;
  const maxPosition = await db.prepare("SELECT COALESCE(MAX(position),-1) AS max_position FROM campaign_assignments WHERE campaign_id=?1").bind(campaign.id).first<{ max_position: number }>();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO campaign_assignments (id,campaign_id,order_id,assigned_agent_id,position,created_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(order_id) DO UPDATE SET campaign_id=excluded.campaign_id,assigned_agent_id=excluded.assigned_agent_id,position=excluded.position,created_at=excluded.created_at").bind(`cma_${randomHex(8)}`, campaign.id, orderId, campaign.assigned_agent_id, Number(maxPosition?.max_position ?? -1) + 1, now),
    db.prepare("UPDATE orders SET confirmation_selected=1,confirmation_status='assigned',assigned_user_id=?1,current_status=CASE WHEN current_status IN ('APPROVED','INGESTED') THEN 'PENDING_CONFIRMATION' ELSE current_status END,updated_at=?2 WHERE id=?3").bind(campaign.assigned_agent_id, now, orderId),
  ]);
  await audit(null, "campaign.auto-assigned", "campaign", String(campaign.id), `Order ${orderId} matched long-term tags: ${[...orderTags].join(", ")}`);
  await broadcastOrderUpdate(orderId, "campaign.auto-assigned");
  return { campaignId: String(campaign.id), agentId: String(campaign.assigned_agent_id) };
}

export async function reorderCampaigns(actor: AppUser, payload: { campaignIds?: string[] }) {
  await ensureDatabase();
  const db = getEnv().DB;
  if (!["ADMIN", "MANAGER"].includes(actor.role)) throw new Error("Only admin and manager can reorder campaigns");
  const campaignIds = [...new Set((payload.campaignIds ?? []).map((value) => String(value)).filter(Boolean))];
  if (!campaignIds.length) throw new Error("Choose at least one campaign");
  const activeCampaigns = await db.prepare("SELECT id,urgency,position,created_at FROM campaigns WHERE is_active=1").all<Row>();
  if (activeCampaigns.results.length !== campaignIds.length || activeCampaigns.results.some((campaign) => !campaignIds.includes(String(campaign.id)))) {
    throw new Error("Campaign order is stale. Reload the board and try again");
  }
  const orderedIds = campaignIds;
  await db.batch(orderedIds.map((campaignId, index) => db.prepare("UPDATE campaigns SET position=?1 WHERE id=?2").bind(index, campaignId)));
  const affectedOrders = await db.prepare(`SELECT order_id FROM campaign_assignments WHERE campaign_id IN (${orderedIds.map((_, index) => `?${index + 1}`).join(",")})`).bind(...orderedIds).all<{ order_id: string }>();
  const now = new Date().toISOString();
  if (affectedOrders.results.length) {
    await db.batch(affectedOrders.results.map((row) => db.prepare("UPDATE orders SET updated_at=?1 WHERE id=?2").bind(now, row.order_id)));
    for (const row of affectedOrders.results) await broadcastOrderUpdate(String(row.order_id), "campaign.reordered");
  }
  await audit(actor.id, "campaign.reordered", "campaign", orderedIds[0], `${orderedIds.length} campaign(s) reprioritized by drag order`);
  return { reordered: orderedIds.length };
}

export async function reviewOrderEditRequest(actor: AppUser, payload: { requestId?: string; decision?: "APPROVE" | "REJECT"; reviewNote?: string }) {
  await ensureDatabase();
  const db = getEnv().DB;
  if (!["ADMIN", "MANAGER"].includes(actor.role)) throw new Error("Only admin and manager can review edit requests");
  const requestId = String(payload.requestId ?? "");
  const decision = String(payload.decision ?? "").toUpperCase();
  if (!requestId || !["APPROVE", "REJECT"].includes(decision)) throw new Error("Choose a valid approval decision");
  const request = await db.prepare(`SELECT r.*,o.shopify_order_id
    FROM order_edit_requests r
    JOIN orders o ON o.id=r.order_id
    WHERE r.id=?1 LIMIT 1`).bind(requestId).first<Row>();
  if (!request) throw new Error("Edit request not found");
  if (String(request.status) !== "PENDING") throw new Error("This edit request has already been reviewed");
  const reviewNote = String(payload.reviewNote ?? "").trim() || null;
  const now = new Date().toISOString();
  if (decision === "REJECT") {
    await db.prepare("UPDATE order_edit_requests SET status='REJECTED',reviewed_by=?1,reviewed_at=?2,review_note=?3 WHERE id=?4")
      .bind(actor.id, now, reviewNote, requestId).run();
    await audit(actor.id, "order-edit.rejected", "order_edit_request", requestId, reviewNote || String(request.field_name));
    return { status: "REJECTED" };
  }

  const fieldName = String(request.field_name);
  const newValue = String(request.new_value);
  const shopifyOrderId = request.shopify_order_id ? String(request.shopify_order_id) : null;
  if (shopifyOrderId) {
    await updateShopifyOrderContact(shopifyOrderId, {
      customerName: fieldName === "customer_name" ? newValue : undefined,
      customerPhone: fieldName === "customer_phone" ? newValue : undefined,
      shippingAddress: fieldName === "shipping_address" ? newValue : undefined,
    });
  }

  const statements = [
    db.prepare("UPDATE order_edit_requests SET status='APPROVED',reviewed_by=?1,reviewed_at=?2,review_note=?3 WHERE id=?4").bind(actor.id, now, reviewNote, requestId),
  ];
  if (fieldName === "customer_name") {
    statements.push(db.prepare("UPDATE orders SET customer_name=?1,updated_at=?2 WHERE id=?3").bind(newValue, now, request.order_id));
  } else if (fieldName === "customer_phone") {
    statements.push(db.prepare("UPDATE orders SET customer_phone=?1,updated_at=?2 WHERE id=?3").bind(newValue, now, request.order_id));
  } else if (fieldName === "shipping_address") {
    const address = splitAddressFields(newValue);
    statements.push(db.prepare("UPDATE orders SET shipping_address=?1,shipping_city=?2,shipping_state=?3,shipping_pincode=?4,shipping_country=?5,updated_at=?6 WHERE id=?7")
      .bind(address.shipping_address || null, address.shipping_city || null, address.shipping_state || null, address.shipping_pincode || null, address.shipping_country || null, now, request.order_id));
  } else {
    throw new Error("Unsupported edit field");
  }
  await db.batch(statements);
  await audit(actor.id, "order-edit.approved", "order_edit_request", requestId, `${fieldName} approved`);
  return { status: "APPROVED" };
}

export async function updateRecallCooldownSettings(actor: AppUser, payload: { defaultHours?: number }) {
  await ensureDatabase();
  const db = getEnv().DB;
  if (!["ADMIN", "MANAGER"].includes(actor.role)) throw new Error("Only admin and manager can update cooldown settings");
  const defaultHours = Math.round(Number(payload.defaultHours ?? 0));
  if (!Number.isFinite(defaultHours) || defaultHours < 1 || defaultHours > 168) throw new Error("Cooldown must be between 1 and 168 hours");
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO recall_cooldown_settings (id,default_hours,updated_by,updated_at) VALUES ('default',?1,?2,?3) ON CONFLICT(id) DO UPDATE SET default_hours=?1,updated_by=?2,updated_at=?3")
    .bind(defaultHours, actor.id, now).run();
  await audit(actor.id, "recall-cooldown.updated", "settings", "default", `${defaultHours}h`);
  return { defaultHours };
}

export async function overrideRecallCooldown(actor: AppUser, payload: { orderId?: string; reason?: string; newNextActionAt?: string }) {
  await ensureDatabase();
  const db = getEnv().DB;
  if (!["ADMIN", "MANAGER"].includes(actor.role)) throw new Error("Only admin and manager can override recall cooldowns");
  const orderId = String(payload.orderId ?? "");
  const reason = String(payload.reason ?? "").trim();
  if (!orderId || !reason) throw new Error("Order and override reason are required");
  const latestAttempt = await db.prepare("SELECT id,next_action_at FROM confirmation_attempts WHERE order_id=?1 ORDER BY attempt_number DESC,created_at DESC LIMIT 1").bind(orderId).first<Row>();
  if (!latestAttempt) throw new Error("This order has no confirmation attempts yet");
  const now = new Date().toISOString();
  const newNextActionAt = payload.newNextActionAt ? String(payload.newNextActionAt) : now;
  await db.batch([
    db.prepare("UPDATE confirmation_attempts SET next_action_at=?1 WHERE id=?2").bind(newNextActionAt, latestAttempt.id),
    db.prepare("INSERT INTO recall_overrides (id,order_id,overridden_by,reason,original_next_action_at,new_next_action_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)")
      .bind(`rov_${randomHex(8)}`, orderId, actor.id, reason, latestAttempt.next_action_at ? String(latestAttempt.next_action_at) : null, newNextActionAt, now),
  ]);
  await audit(actor.id, "recall.override", "order", orderId, reason);
  return { nextActionAt: newNextActionAt };
}

export async function backfillRequirementSnapshots(actor: AppUser) {
  await ensureDatabase();
  const db = getEnv().DB;
  if (!["ADMIN", "MANAGER"].includes(actor.role)) throw new Error("Only admin and manager can rebuild requirement snapshots");
  const before = await db.prepare("SELECT COUNT(*) AS count FROM order_requirement_sets WHERE status='missing' OR status IS NULL").first<Row>();
  const orders = await db.prepare(`SELECT DISTINCT o.id,o.status,o.tracking_status
    FROM orders o
    LEFT JOIN order_requirement_sets s ON s.order_id=o.id
    WHERE o.status NOT IN ('cancelled','delivered','rto_delivered')
      AND (s.status IS NULL OR s.status='missing')`).all<Row>();
  let rebuilt = 0;
  for (const order of orders.results) {
    const result = await snapshotOrderRequirements(String(order.id), actor.id, true, true);
    if (result.status !== "historical") rebuilt += 1;
  }
  const after = await db.prepare("SELECT COUNT(*) AS count FROM order_requirement_sets WHERE status='missing' OR status IS NULL").first<Row>();
  await audit(actor.id, "requirements.backfilled", "system", "order-requirements", `${rebuilt} rebuilt · ${num(before?.count)} before · ${num(after?.count)} after`);
  return { rebuilt, before: num(before?.count), after: num(after?.count) };
}

export async function completeRto(actor: AppUser, taskId: string, payload: { lines?: Array<{ orderLineId: string; goodQuantity: number; damagedQuantity: number }>; manualReceipts?: Array<{ componentId: string; quantity: number }>; note?: string }) {
  await ensureDatabase();
  const db = getEnv().DB;
  const task = await db.prepare("SELECT order_id,status FROM rto_tasks WHERE id=?1").bind(taskId).first<Row>();
  if (!task) throw new Error("RTO task not found");
  if (String(task.status) === "completed") throw new Error("RTO task is already completed");
  const orderLines = await db.prepare("SELECT id,quantity FROM order_lines WHERE order_id=?1").bind(task.order_id).all<Row>();
  const submitted = payload.lines ?? [];
  const snapshotLineIds = new Set<string>();
  for (const line of orderLines.results) {
    const result = submitted.find((item) => item.orderLineId === line.id); const hasSnapshot = await db.prepare("SELECT id FROM order_requirements WHERE order_line_id=?1 AND source='BOM' LIMIT 1").bind(line.id).first();
    if (hasSnapshot) snapshotLineIds.add(String(line.id));
    if (hasSnapshot && (!result || !Number.isInteger(result.goodQuantity) || !Number.isInteger(result.damagedQuantity) || result.goodQuantity < 0 || result.damagedQuantity < 0 || result.goodQuantity + result.damagedQuantity !== num(line.quantity))) throw new Error("Good and damaged quantities must equal every returned line quantity");
  }
  const hasHistoricalLines = orderLines.results.some((line) => !snapshotLineIds.has(String(line.id)));
  if (hasHistoricalLines && !(payload.manualReceipts?.length)) throw new Error("Historical RTO lines require actual recovered component quantities");
  const now = new Date().toISOString();
  const statements = [db.prepare("UPDATE rto_tasks SET status='completed',outcome='partial-qc',note=?1,completed_by=?2,completed_at=?3 WHERE id=?4").bind(payload.note || "Warehouse component QC completed", actor.id, now, taskId)];
  for (const result of submitted.filter((item) => snapshotLineIds.has(item.orderLineId))) {
    statements.push(db.prepare("INSERT INTO rto_qc_lines(id,task_id,order_line_id,good_quantity,damaged_quantity,created_at) VALUES(?1,?2,?3,?4,?5,?6)").bind(`rql_${randomHex(8)}`, taskId, result.orderLineId, result.goodQuantity, result.damagedQuantity, now));
    const reqs = await db.prepare("SELECT r.component_id,r.required_quantity,ol.quantity FROM order_requirements r JOIN order_lines ol ON ol.id=r.order_line_id JOIN inventory_components c ON c.id=r.component_id WHERE r.order_line_id=?1 AND r.source='BOM' AND c.rto_recoverable=1 AND c.component_type<>'COURIER_BOX'").bind(result.orderLineId).all<Row>();
    for (const req of reqs.results) { const perUnit = num(req.required_quantity) / Math.max(1, num(req.quantity)); const quantity = perUnit * result.goodQuantity; if (quantity > 0) statements.push(db.prepare("INSERT INTO component_ledger(id,component_id,movement_type,quantity,reference_type,reference_id,reason,created_by,created_at) VALUES(?1,?2,'RTO-QC-pass',?3,'rto',?4,?5,?6,?7)").bind(`cled_${randomHex(9)}`, req.component_id, quantity, taskId, payload.note || "Recoverable component passed RTO QC", actor.id, now)); }
  }
  for (const receipt of payload.manualReceipts ?? []) {
    if (!receipt.componentId || !Number.isInteger(receipt.quantity) || receipt.quantity < 1) throw new Error("Manual recovered components require positive whole quantities");
    const component = await db.prepare("SELECT id FROM inventory_components WHERE id=?1 AND active=1 AND component_type<>'COURIER_BOX'").bind(receipt.componentId).first();
    if (!component) throw new Error("Courier boxes and inactive components cannot be manually returned");
    statements.push(db.prepare("INSERT INTO component_ledger(id,component_id,movement_type,quantity,reference_type,reference_id,reason,created_by,created_at) VALUES(?1,?2,'RTO-manual-receipt',?3,'rto',?4,?5,?6,?7)").bind(`cled_${randomHex(9)}`, receipt.componentId, receipt.quantity, taskId, payload.note || "Historical RTO manual receipt", actor.id, now));
  }
  await db.batch(statements);
  await audit(actor.id, "rto.partial-qc", "rto", taskId, payload.note || "QC completed");
  await reallocateComponents();
}

let integrationSyncInFlight: Promise<void> | null = null;

export function beginIntegrationSync(actor: AppUser) {
  if (integrationSyncInFlight) return { started: false, promise: integrationSyncInFlight };
  const promise = markIntegrationSync(actor).finally(() => {
    if (integrationSyncInFlight === promise) integrationSyncInFlight = null;
  });
  integrationSyncInFlight = promise;
  return { started: true, promise };
}

export async function markIntegrationSync(actor: AppUser) {
  console.log("[markIntegrationSync] STARTING SYNC for actor:", actor.id);
  const now = new Date().toISOString();
  await ensureDatabase();
  const db = getEnv().DB;
  const appMode = getEnv().APP_MODE || "live";
  console.log("[markIntegrationSync] APP_MODE =", appMode);
  if (appMode === "sample") {
    await db.batch([
      db.prepare("UPDATE integration_state SET last_synced_at=?1,updated_at=?1,detail='Sample sync completed · no external writes' WHERE provider='shopify'").bind(now),
      db.prepare("UPDATE integration_state SET last_synced_at=?1,updated_at=?1,detail='Sample sync completed · channel data preserved' WHERE provider='shiprocket'").bind(now),
    ]);
    await audit(actor.id, "integrations.synced", "system", "integrations", "Manual sample sync completed");
    console.log("[markIntegrationSync] DONE (sample)");
    return;
  }
  console.log("[markIntegrationSync] Importing integrations...");
  const { syncShopifyOrders, syncShiprocketOpenOrders, backfillInvalidSkuOrderLines, reconcileRecentShiprocketOrders } = await import("./integrations");
  await db.batch([
    db.prepare("UPDATE integration_state SET status='syncing',detail='Importing locally cached Shopify orders, tags, and products',updated_at=?1 WHERE provider='shopify'").bind(now),
    db.prepare("UPDATE integration_state SET status='syncing',detail='Importing Shiprocket channel orders and shipment status',updated_at=?1 WHERE provider='shiprocket'").bind(now),
  ]);
  const changedOrderIds = new Set<string>();
  const results: string[] = [];
  try {
    const shopify = await syncShopifyOrders();
    const backfill = await backfillInvalidSkuOrderLines();
    for (const orderId of shopify.orderIds) await assignOrderToLongTermCampaign(orderId);
    for (const orderId of shopify.orderIds) changedOrderIds.add(orderId);
    for (const orderId of backfill.orderIds) changedOrderIds.add(orderId);
    await db.prepare("UPDATE integration_state SET status='connected',detail=?1,last_synced_at=?2,updated_at=?2 WHERE provider='shopify'").bind(`${shopify.orders} Shopify orders reconciled · ${shopify.mode} sync · ${backfill.updated} order lines backfilled`, now).run();
    results.push(`Shopify ${shopify.orders} · ${shopify.mode} · backfilled ${backfill.updated}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Shopify sync failed";
    await db.batch([
      db.prepare("UPDATE integration_state SET status='action-required',detail=?1,updated_at=?2 WHERE provider='shopify'").bind(detail, now),
      db.prepare(`INSERT INTO integration_sync_cursors(provider,full_backfill_complete,last_error,updated_at) VALUES('shopify',0,?1,?2)
        ON CONFLICT(provider) DO UPDATE SET last_error=?1,updated_at=?2`).bind(detail, now),
    ]);
    results.push("Shopify needs OAuth");
  }
  try {
    const shiprocket = await syncShiprocketOpenOrders();
    const reconciliation = shiprocket.complete ? await reconcileRecentShiprocketOrders() : { checked: 0, changed: 0, orderIds: [] as string[] };
    for (const orderId of shiprocket.orderIds) changedOrderIds.add(orderId);
    for (const orderId of reconciliation.orderIds) changedOrderIds.add(orderId);
    await db.prepare("UPDATE integration_state SET status=?1,detail=?2,last_synced_at=?3,updated_at=?3 WHERE provider='shiprocket'").bind(shiprocket.complete ? "connected" : "syncing", `${shiprocket.imported} channel orders reconciled · ${shiprocket.mode} sync${shiprocket.complete ? ` · ${reconciliation.changed} recent shipment refreshes` : ` · next page ${shiprocket.nextPage}`}`, now).run();
    results.push(`Shiprocket ${shiprocket.imported} · ${shiprocket.mode} · refreshed ${reconciliation.changed}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Shiprocket sync failed";
    await db.batch([
      db.prepare("UPDATE integration_state SET status='error',detail=?1,updated_at=?2 WHERE provider='shiprocket'").bind(detail, now),
      db.prepare(`INSERT INTO integration_sync_cursors(provider,full_backfill_complete,last_error,updated_at) VALUES('shiprocket',0,?1,?2)
        ON CONFLICT(provider) DO UPDATE SET last_error=?1,updated_at=?2`).bind(detail, now),
    ]);
    results.push("Shiprocket failed");
  }
  await audit(actor.id, "integrations.synced", "system", "integrations", results.join(" · "));
  for (const orderId of changedOrderIds) await broadcastOrderUpdate(orderId, "manual.integration-sync");
}

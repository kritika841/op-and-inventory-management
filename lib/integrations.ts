import { decryptValue, encryptValue, randomHex, safeEqual } from "./crypto";
import { audit, ensureDatabase, getEnv, requiredEnv } from "./database";
import { isDispatched, reallocateComponents, snapshotOrderRequirements } from "./components";
import { broadcastOrderUpdate } from "./realtime";
import { normalizeShiprocketCurrentStatus, normalizeShiprocketOrderStatus, normalizeShiprocketTracking } from "./shipping";

type JsonRecord = Record<string, unknown>;

const EXTERNAL_REQUEST_TIMEOUT_MS = 12_000;

function isoTimestamp(value: unknown, fallback = new Date().toISOString()) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const srMatch = raw.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (srMatch) {
    const [, day, month, year, hours, minutes, ampm] = srMatch;
    let h = parseInt(hours, 10);
    if (ampm.toUpperCase() === "PM" && h < 12) h += 12;
    if (ampm.toUpperCase() === "AM" && h === 12) h = 0;
    const months: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    const m = months[month.toLowerCase()] || "01";
    const d = day.padStart(2, "0");
    const hh = String(h).padStart(2, "0");
    const mm = minutes.padStart(2, "0");
    const dt = new Date(`${year}-${m}-${d}T${hh}:${mm}:00+05:30`);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export function isSampleMode() {
  return (getEnv().APP_MODE || "live") === "sample";
}

async function fetchWithTimeout(input: string | URL | Request, init: RequestInit = {}, timeoutMs = EXTERNAL_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(`Timed out after ${timeoutMs}ms`), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function describeNetworkError(provider: string, error: unknown) {
  if (error instanceof Error) {
    if (error.name === "AbortError") return `${provider} request timed out. The local dashboard stayed up, but the external sync did not finish.`;
    return `${provider} request failed: ${error.message}`;
  }
  return `${provider} request failed`;
}

function findFirstUrl(value: unknown): string | null {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const found = findFirstUrl(nested);
      if (found) return found;
    }
  }
  return null;
}

export async function verifyHmac(rawBody: string, signature: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  let binary = "";
  for (const byte of signed) binary += String.fromCharCode(byte);
  return safeEqual(btoa(binary), signature);
}

export async function verifyHmacHex(message: string, signature: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  const hex = Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return safeEqual(hex, signature);
}

export async function storeShopifyToken(accessToken: string) {
  await ensureDatabase();
  const runtime = getEnv();
  const encrypted = await encryptValue(accessToken, requiredEnv("TOKEN_ENCRYPTION_KEY"));
  const now = new Date().toISOString();
  await runtime.DB.prepare("INSERT INTO integration_state (provider,status,detail,secret_value,last_synced_at,updated_at) VALUES ('shopify','connected','OAuth connected',?1,NULL,?2) ON CONFLICT(provider) DO UPDATE SET status='connected',detail='OAuth connected',secret_value=?1,updated_at=?2").bind(encrypted, now).run();
}

async function shopifyToken() {
  const runtime = getEnv();
  const configuredToken = runtime.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
  if (configuredToken) return configuredToken;
  await ensureDatabase();
  const row = await runtime.DB.prepare("SELECT secret_value FROM integration_state WHERE provider='shopify'").first<{ secret_value: string | null }>();
  if (!row?.secret_value) throw new Error("Shopify is not connected");
  return decryptValue(row.secret_value, requiredEnv("TOKEN_ENCRYPTION_KEY"));
}

export async function shopifyGraphql(query: string, variables: JsonRecord = {}) {
  const runtime = getEnv();
  const domain = runtime.SHOPIFY_SHOP_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const apiVersion = (runtime.SHOPIFY_API_VERSION || "2026-04").trim();
  if (!domain) throw new Error("SHOPIFY_SHOP_DOMAIN is not configured");
  if (!/^\d{4}-\d{2}$/.test(apiVersion)) throw new Error("SHOPIFY_API_VERSION must use YYYY-MM format");
  let response: Response;
  try {
    response = await fetchWithTimeout(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": await shopifyToken() },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw new Error(describeNetworkError("Shopify", error));
  }
  const raw = await response.text();
  let payload: JsonRecord = {};
  try { payload = JSON.parse(raw) as JsonRecord; } catch { /* response is included in the safe error below */ }
  if (!response.ok || payload.errors) {
    const message = Array.isArray(payload.errors) ? JSON.stringify(payload.errors) : String(payload.errors ?? raw.slice(0, 300));
    throw new Error(`Shopify request failed (${response.status}): ${message}`);
  }
  return payload;
}

export async function tagShopifyOrder(shopifyOrderId: string, outcome: string) {
  if (isSampleMode() || !shopifyOrderId) return;
  await shopifyGraphql(
    `mutation AddOpsTag($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
    { id: shopifyOrderId, tags: [`ops-${outcome}`] },
  );
}

function splitShippingAddress(value: string) {
  const parts = value.split(",").map((item) => item.trim()).filter(Boolean);
  const country = parts.length >= 5 ? parts.pop() ?? "" : "";
  const zip = parts.length >= 4 ? parts.pop() ?? "" : "";
  const province = parts.length >= 3 ? parts.pop() ?? "" : "";
  const city = parts.length >= 2 ? parts.pop() ?? "" : "";
  const address1 = parts.join(", ");
  return { address1, city, province, zip, country };
}

export async function updateShopifyOrderContact(
  shopifyOrderId: string,
  fields: { customerName?: string | null; customerPhone?: string | null; shippingAddress?: string | null },
) {
  if (isSampleMode() || !shopifyOrderId) return;
  const input: JsonRecord = { id: shopifyOrderId };
  if (fields.customerName !== undefined) input.shippingAddress = { ...((input.shippingAddress as JsonRecord | undefined) ?? {}), name: String(fields.customerName ?? "").trim() || null };
  if (fields.customerPhone !== undefined) input.phone = String(fields.customerPhone ?? "").trim() || null;
  if (fields.shippingAddress !== undefined) {
    input.shippingAddress = {
      ...((input.shippingAddress as JsonRecord | undefined) ?? {}),
      ...splitShippingAddress(String(fields.shippingAddress ?? "").trim()),
    };
  }
  const payload = await shopifyGraphql(
    `mutation UpdateOrderContact($input: OrderInput!) {
      orderUpdate(input: $input) {
        userErrors {
          field
          message
        }
      }
    }`,
    { input },
  ) as { data?: { orderUpdate?: { userErrors?: Array<{ field?: string[]; message?: string }> } } };
  const userErrors = payload.data?.orderUpdate?.userErrors ?? [];
  if (userErrors.length) throw new Error(userErrors.map((item) => item.message || "Shopify rejected the update").join(", "));
}

async function shiprocketToken() {
  const runtime = getEnv();
  if (!runtime.SHIPROCKET_EMAIL || !runtime.SHIPROCKET_PASSWORD) throw new Error("Shiprocket credentials are not configured");
  await ensureDatabase();
  const cached = await runtime.DB.prepare("SELECT secret_value,updated_at FROM integration_state WHERE provider='shiprocket'").first<{ secret_value: string | null; updated_at: string }>();
  if (cached?.secret_value && Date.now() - new Date(cached.updated_at).getTime() < 9 * 86_400_000) {
    return decryptValue(cached.secret_value, requiredEnv("TOKEN_ENCRYPTION_KEY"));
  }
  let response: Response;
  try {
    response = await fetchWithTimeout("https://apiv2.shiprocket.in/v1/external/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: runtime.SHIPROCKET_EMAIL, password: runtime.SHIPROCKET_PASSWORD }),
    }, 25_000);
  } catch (error) {
    throw new Error(describeNetworkError("Shiprocket authentication", error));
  }
  const payload = await response.json() as { token?: string };
  if (!response.ok || !payload.token) throw new Error("Shiprocket authentication failed");
  const encrypted = await encryptValue(payload.token, requiredEnv("TOKEN_ENCRYPTION_KEY"));
  const now = new Date().toISOString();
  await runtime.DB.prepare("INSERT INTO integration_state (provider,status,detail,secret_value,last_synced_at,updated_at) VALUES ('shiprocket','connected','API connected',?1,NULL,?2) ON CONFLICT(provider) DO UPDATE SET status='connected',detail='API connected',secret_value=?1,updated_at=?2").bind(encrypted, now).run();
  return payload.token;
}

function parseShiprocketTimestamp(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "0000-00-00 00:00:00" || raw === "NA") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

type ShiprocketOrderSnapshot = {
  shiprocketOrderId: string;
  shiprocketShipmentId: string | null;
  awb: string | null;
  courier: string | null;
  trackingStatus: string;
  currentStatus: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  pickupScheduledAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  autoCancelledAt: string | null;
  rtoEta: string | null;
  rawOrder: JsonRecord;
};

function extractShiprocketSnapshot(order: JsonRecord): ShiprocketOrderSnapshot {
  const shipments = Array.isArray(order.shipments) ? order.shipments as JsonRecord[] : [];
  const shipment = shipments[0] ?? {};
  const rawStatus = shipment.status_code ?? shipment.current_status_id ?? shipment.status ?? order.status_code ?? order.current_status_id ?? order.status ?? "pending";
  const trackingStatus = normalizeShiprocketTracking(rawStatus);
  return {
    shiprocketOrderId: String(order.id || ""),
    shiprocketShipmentId: shipment.id || shipment.shipment_id ? String(shipment.id ?? shipment.shipment_id) : null,
    awb: shipment.awb || shipment.awb_code || shipment.awb_number || order.awb || order.awb_code || order.awb_number || order.last_mile_awb
      ? String(shipment.awb ?? shipment.awb_code ?? shipment.awb_number ?? order.awb ?? order.awb_code ?? order.awb_number ?? order.last_mile_awb)
      : null,
    courier: shipment.sr_courier_name || shipment.courier_name || shipment.courier || order.courier_name || order.courier || order.last_mile_courier_name
      ? String(shipment.sr_courier_name ?? shipment.courier_name ?? shipment.courier ?? order.courier_name ?? order.courier ?? order.last_mile_courier_name)
      : null,
    trackingStatus,
    currentStatus: normalizeShiprocketCurrentStatus(rawStatus),
    status: normalizeShiprocketOrderStatus(rawStatus),
    createdAt: isoTimestamp(order.channel_created_at || order.created_at),
    updatedAt: isoTimestamp(order.updated_at || order.updated_on || order.channel_created_at || order.created_at),
    pickupScheduledAt: parseShiprocketTimestamp(shipment.pickup_scheduled_date || shipment.pickup_scheduled_at || order.pickup_scheduled_date),
    pickedUpAt: parseShiprocketTimestamp(shipment.pickedup_timestamp || shipment.picked_up_at || shipment.picked_up_date || order.picked_up_date || order.pickup_booked_date),
    deliveredAt: parseShiprocketTimestamp(shipment.delivered_date || order.delivered_date),
    autoCancelledAt: trackingStatus.includes("cancel") ? isoTimestamp(order.updated_at || order.updated_on || new Date().toISOString()) : null,
    rtoEta: order.rto_edd ? String(order.rto_edd) : shipment.etd ? String(shipment.etd) : null,
    rawOrder: order,
  };
}

const courierSlaCache = new Map<string, number | null>();

async function upsertShipmentRecord(orderId: string, snapshot: ShiprocketOrderSnapshot) {
  const runtime = getEnv();
  const shipmentRow = snapshot.shiprocketShipmentId
    ? await runtime.DB.prepare("SELECT id FROM shipments WHERE shiprocket_shipment_id=?1 LIMIT 1").bind(snapshot.shiprocketShipmentId).first<{ id: string }>()
    : await runtime.DB.prepare("SELECT id FROM shipments WHERE order_id=?1 AND is_active=1 ORDER BY manifested_at DESC NULLS LAST LIMIT 1").bind(orderId).first<{ id: string }>();
  const shipmentId = shipmentRow?.id ?? `shp_${randomHex(8)}`;
  let autoCancelDays: number | null = null;
  if (snapshot.courier) {
    const courierKey = snapshot.courier.toLowerCase();
    if (courierSlaCache.has(courierKey)) {
      autoCancelDays = courierSlaCache.get(courierKey) ?? null;
    } else {
      const courierRow = await runtime.DB.prepare("SELECT auto_cancel_days FROM courier_sla WHERE lower(courier_name)=lower(?1) LIMIT 1").bind(snapshot.courier).first<{ auto_cancel_days: number | null }>();
      autoCancelDays = courierRow?.auto_cancel_days ?? null;
      courierSlaCache.set(courierKey, autoCancelDays);
    }
  }
  const autoCancelDeadline = autoCancelDays && snapshot.pickupScheduledAt
    ? new Date(new Date(snapshot.pickupScheduledAt).getTime() + autoCancelDays * 86_400_000).toISOString()
    : null;
  await runtime.DB.prepare(`INSERT INTO shipments (id,order_id,attempt_number,shiprocket_order_id,shiprocket_shipment_id,awb_number,courier_name,courier_auto_cancel_days,auto_cancel_deadline,status,manifested_at,label_printed_at,pickup_scheduled_at,picked_up_at,delivered_at,auto_cancelled_at,is_active)
    VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,1)
    ON CONFLICT(id) DO UPDATE SET
      shiprocket_order_id=COALESCE(?3,shipments.shiprocket_order_id),
      shiprocket_shipment_id=COALESCE(?4,shipments.shiprocket_shipment_id),
      awb_number=COALESCE(?5,shipments.awb_number),
      courier_name=COALESCE(?6,shipments.courier_name),
      courier_auto_cancel_days=COALESCE(?7,shipments.courier_auto_cancel_days),
      auto_cancel_deadline=COALESCE(?8,shipments.auto_cancel_deadline),
      status=?9,
      manifested_at=COALESCE(shipments.manifested_at,?10),
      label_printed_at=CASE WHEN ?9='LABEL_PRINTED' THEN COALESCE(shipments.label_printed_at,?11) ELSE shipments.label_printed_at END,
      pickup_scheduled_at=COALESCE(?12,shipments.pickup_scheduled_at),
      picked_up_at=COALESCE(?13,shipments.picked_up_at),
      delivered_at=COALESCE(?14,shipments.delivered_at),
      auto_cancelled_at=COALESCE(?15,shipments.auto_cancelled_at),
      is_active=1`)
    .bind(
      shipmentId,
      orderId,
      snapshot.shiprocketOrderId,
      snapshot.shiprocketShipmentId,
      snapshot.awb,
      snapshot.courier,
      autoCancelDays,
      autoCancelDeadline,
      snapshot.currentStatus,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.pickupScheduledAt,
      snapshot.pickedUpAt,
      snapshot.deliveredAt,
      snapshot.autoCancelledAt,
    ).run();
}

export async function lookupShiprocketOrder(channelOrderId: string) {
  const url = new URL("https://apiv2.shiprocket.in/v1/external/orders");
  url.searchParams.set("search", channelOrderId.replace(/^#/, ""));
  let response: Response;
  try {
    response = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${await shiprocketToken()}`, accept: "application/json" } });
  } catch (error) {
    throw new Error(describeNetworkError("Shiprocket lookup", error));
  }
  const payload = await response.json() as { data?: JsonRecord[] };
  if (!response.ok) throw new Error(`Shiprocket lookup failed (${response.status})`);
  const order = payload.data?.find((item) => String(item.channel_order_id ?? "").replace(/^#/, "").toUpperCase() === channelOrderId.replace(/^#/, "").toUpperCase()) ?? payload.data?.[0];
  return order ? extractShiprocketSnapshot(order) : null;
}

export async function checkShiprocketConnectivity() {
  const startedAt = Date.now();
  const url = new URL("https://apiv2.shiprocket.in/v1/external/orders");
  url.searchParams.set("per_page", "1");
  url.searchParams.set("page", "1");
  const response = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${await shiprocketToken()}`, accept: "application/json" } }, 25_000);
  if (!response.ok) throw new Error(`Shiprocket health check failed (${response.status})`);
  return { ok: true, latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString() };
}

export async function syncOrderFromShiprocket(orderId: string) {
  await ensureDatabase();
  const runtime = getEnv();
  const order = await runtime.DB.prepare("SELECT order_number,awb,tracking_status FROM orders WHERE id=?1").bind(orderId).first<{ order_number: string; awb: string | null; tracking_status: string | null }>();
  if (!order) throw new Error("Order not found");
  const match = await lookupShiprocketOrder(order.order_number);
  if (!match) throw new Error("Order has not appeared in the configured Shiprocket channel yet");
  const awbWasRemoved = Boolean(order.awb && !match.awb);
  const trackingStatus = awbWasRemoved || order.tracking_status === "cancelled_after_awb" ? "cancelled_after_awb" : match.trackingStatus;
  const currentStatus = awbWasRemoved || order.tracking_status === "cancelled_after_awb" ? "SHIPMENT_AUTO_CANCELLED" : match.currentStatus;
  const orderStatus = awbWasRemoved || order.tracking_status === "cancelled_after_awb" ? "cancelled" : match.status;
  await runtime.DB.prepare("UPDATE orders SET shiprocket_order_id=?1,shipment_id=?2,awb=COALESCE(?3,awb),courier=COALESCE(?4,courier),tracking_status=?5,current_status=?6,status=?7,rto_eta=COALESCE(?8,rto_eta),updated_at=?9 WHERE id=?10")
    .bind(match.shiprocketOrderId, match.shiprocketShipmentId, match.awb, match.courier, trackingStatus, currentStatus, orderStatus, match.rtoEta, match.updatedAt, orderId).run();
  if (awbWasRemoved) {
    await runtime.DB.prepare("UPDATE orders SET cancellation_source='Shiprocket',cancellation_reason='AWB was cancelled or removed after generation',cancelled_by=COALESCE(cancelled_by,'Not provided by Shiprocket'),cancelled_at=COALESCE(cancelled_at,?1) WHERE id=?2")
      .bind(match.updatedAt, orderId).run();
  }
  await upsertShipmentRecord(orderId, { ...match, trackingStatus, currentStatus, status: orderStatus });
  if (match.awb) await runtime.DB.prepare("UPDATE shipment_events SET order_id=?1 WHERE order_id IS NULL AND awb=?2").bind(orderId, match.awb).run();
  return { ...match, trackingStatus, currentStatus, status: orderStatus };
}

function shopifyId(value: unknown) {
  return String(value ?? "").split("/").pop() || randomHex(8);
}

async function findProductMatchByName(name: string) {
  const normalized = name.trim();
  if (!normalized) return null;
  const runtime = getEnv();
  const matches = await runtime.DB.prepare("SELECT id,sku FROM products WHERE lower(name)=lower(?1) AND active=1 LIMIT 2").bind(normalized).all<{ id: string; sku: string }>();
  return matches.results.length === 1 ? matches.results[0] : null;
}

export async function backfillInvalidSkuOrderLines() {
  await ensureDatabase();
  const runtime = getEnv();
  const rows = await runtime.DB.prepare(
    "SELECT id,order_id,name,sku FROM order_lines WHERE product_id IS NULL OR sku='INVALID-SKU'",
  ).all<{ id: string; order_id: string; name: string; sku: string }>();

  let updated = 0;
  const impactedOrderIds = new Set<string>();
  const updateStatements = [];

  for (const row of rows.results) {
    const lineName = String(row.name || "").trim();
    const lineSku = String(row.sku || "").trim();
    const matchedBySku = lineSku && lineSku !== "INVALID-SKU"
      ? await runtime.DB.prepare("SELECT id,sku FROM products WHERE sku=?1 AND active=1 LIMIT 1").bind(lineSku).first<{ id: string; sku: string }>()
      : null;
    const matchedByName = matchedBySku ? null : await findProductMatchByName(lineName);
    const resolved = matchedBySku ?? matchedByName;
    if (!resolved) continue;

    updateStatements.push(
      runtime.DB.prepare("UPDATE order_lines SET product_id=?1, sku=?2 WHERE id=?3").bind(String(resolved.id), String(resolved.sku), String(row.id))
    );
    if (row.order_id) impactedOrderIds.add(String(row.order_id));
    updated += 1;
  }

  if (updateStatements.length) {
    await runtime.DB.batch(updateStatements);
    for (const orderId of impactedOrderIds) {
      await snapshotOrderRequirements(orderId, null, true, true, true);
    }
    await reallocateComponents();
  }

  return { scanned: rows.results.length, updated, orderIds: [...impactedOrderIds] };
}

export async function syncShopifyProducts(actorId: string | null = null) {
  await ensureDatabase();
  const runtime = getEnv();
  const syncStartedAt = new Date().toISOString();

  const liveVariants: Array<{
    variantId: string;
    variantGid: string;
    productTitle: string;
    variantTitle: string;
    sku: string;
    status: string;
  }> = [];

  let after: string | null = null;
  do {
    const payload = await shopifyGraphql(`query AllProducts($after: String) {
      products(first: 100, after: $after) {
        nodes {
          id
          title
          status
          variants(first: 50) {
            nodes {
              id
              sku
              title
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }`, { after });

    const data = payload.data as {
      products?: {
        nodes?: Array<{
          id: string;
          title: string;
          status: string;
          variants?: {
            nodes?: Array<{
              id: string;
              sku: string | null;
              title: string;
            }>;
          };
        }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    } | undefined;

    const products = data?.products?.nodes ?? [];
    for (const p of products) {
      for (const v of p.variants?.nodes ?? []) {
        liveVariants.push({
          variantId: shopifyId(v.id),
          variantGid: String(v.id),
          productTitle: String(p.title || "").trim(),
          variantTitle: String(v.title || "Default").trim(),
          sku: String(v.sku || "").trim(),
          status: String(p.status || "ACTIVE").toUpperCase(),
        });
      }
    }
    after = data?.products?.pageInfo?.hasNextPage ? data.products.pageInfo.endCursor ?? null : null;
  } while (after);

  const localProducts = await runtime.DB.prepare("SELECT * FROM products").all<JsonRecord>();
  const localByVariantGid = new Map<string, JsonRecord>();
  const localBySku = new Map<string, JsonRecord>();
  for (const row of localProducts.results) {
    if (row.shopify_variant_id) localByVariantGid.set(String(row.shopify_variant_id), row);
    if (row.sku) localBySku.set(String(row.sku).toUpperCase(), row);
  }

  let inserted = 0;
  let updated = 0;
  const statements = [];

  for (const item of liveVariants) {
    const rawSku = item.sku;
    const finalSku = (rawSku || `SPFY-${item.variantId}`).toUpperCase();
    const displayName = item.variantTitle === "Default Title" || item.variantTitle === "Default"
      ? item.productTitle
      : `${item.productTitle} - ${item.variantTitle}`;
    const isActive = item.status === "ACTIVE" ? 1 : 0;

    const existing = localByVariantGid.get(item.variantGid) ?? localBySku.get(finalSku);

    if (existing) {
      statements.push(
        runtime.DB.prepare(
          "UPDATE products SET shopify_variant_id=?1, name=?2, variant=?3, active=?4 WHERE id=?5"
        ).bind(item.variantGid, displayName, item.variantTitle, isActive, existing.id)
      );
      updated += 1;
    } else {
      const newProductId = `shpvar_${item.variantId}`;
      statements.push(
        runtime.DB.prepare(
          "INSERT INTO products (id, shopify_variant_id, sku, name, variant, active) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(sku) DO UPDATE SET shopify_variant_id=?2, name=?4, variant=?5, active=?6"
        ).bind(newProductId, item.variantGid, finalSku, displayName, item.variantTitle, isActive)
      );
      inserted += 1;
    }
  }

  // Execute statements in batches of 30
  for (let i = 0; i < statements.length; i += 30) {
    await runtime.DB.batch(statements.slice(i, i + 30));
  }

  const backfill = await backfillInvalidSkuOrderLines();
  const finalLocal = await runtime.DB.prepare("SELECT COUNT(*) as total, COUNT(CASE WHEN active=1 THEN 1 END) as active_total FROM products").first<{ total: number; active_total: number }>();
  const totalLocal = Number(finalLocal?.total ?? 0);
  const activeLocal = Number(finalLocal?.active_total ?? 0);

  const orphaned = localProducts.results.filter(
    (p) => p.shopify_variant_id && !liveVariants.some((v) => v.variantGid === p.shopify_variant_id)
  );

  if (actorId) {
    await audit(actorId, "shopify.products-synced", "integration", "shopify", `Imported ${liveVariants.length} Shopify variants (${inserted} new, ${updated} updated, ${totalLocal} total local)`);
  }

  return {
    ok: true,
    shopifyTotalVariants: liveVariants.length,
    shopifyActiveVariants: liveVariants.filter((v) => v.status === "ACTIVE").length,
    localTotalProducts: totalLocal,
    localActiveProducts: activeLocal,
    inserted,
    updated,
    orphanedCount: orphaned.length,
    backfilledLines: backfill.updated,
    syncedAt: syncStartedAt,
  };
}

export async function syncShopifyOrders() {
  await ensureDatabase();
  const runtime = getEnv();
  const syncStartedAt = new Date().toISOString();
  const cursor = await runtime.DB.prepare("SELECT full_backfill_complete,last_success_at FROM integration_sync_cursors WHERE provider='shopify'").first<{ full_backfill_complete: number; last_success_at: string | null }>();
  const incrementalSince = Number(cursor?.full_backfill_complete) && cursor?.last_success_at ? new Date(new Date(cursor.last_success_at).getTime() - 3_600_000).toISOString() : null;
  const orders: JsonRecord[] = [];
  let after: string | null = null;
  do {
    const payload = await shopifyGraphql(`query RecentOrders($query: String!, $after: String) {
    orders(first: 100, after: $after, sortKey: UPDATED_AT, reverse: true, query: $query) {
      nodes { id name tags createdAt updatedAt cancelledAt cancelReason cancellation { staffNote }
        events(first: 10, reverse: true) { nodes { action appTitle attributeToApp attributeToUser message ... on BasicEvent { author } } }
        displayFinancialStatus totalPriceSet { shopMoney { amount } }
        customer { displayName phone defaultAddress { phone } }
        lineItems(first: 100) { nodes { id name quantity sku variant { id title sku product { title } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { query: incrementalSince ? `updated_at:>=${incrementalSince}` : "", after });
    const data = payload.data as { orders?: { nodes?: JsonRecord[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } | undefined;
    orders.push(...(data?.orders?.nodes ?? []));
    after = data?.orders?.pageInfo?.hasNextPage ? data.orders.pageInfo.endCursor ?? null : null;
  } while (after);
  let lineCount = 0;
  const orderIds: string[] = [];
  for (const order of orders) {
    const orderNumber = String(order.name ?? `#${shopifyId(order.id)}`);
    const existing = await runtime.DB.prepare("SELECT id FROM orders WHERE shopify_order_id=?1 OR LTRIM(order_number,'#')=?2 ORDER BY shopify_order_id IS NOT NULL DESC LIMIT 1").bind(String(order.id), orderNumber.replace(/^#/, "")).first<{ id: string }>();
    const orderId = existing?.id ?? `shpord_${shopifyId(order.id)}`;
    const customer = (order.customer ?? {}) as JsonRecord;
    const address = (customer.defaultAddress ?? {}) as JsonRecord;
    const money = (((order.totalPriceSet ?? {}) as JsonRecord).shopMoney ?? {}) as JsonRecord;
    const status = order.cancelledAt ? "cancelled" : "open";
    await runtime.DB.prepare(`INSERT INTO orders (id,shopify_order_id,order_number,customer_name,customer_phone,payment_method,amount,status,created_at,updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
      ON CONFLICT(id) DO UPDATE SET shopify_order_id=?2,order_number=?3,customer_name=?4,customer_phone=?5,payment_method=?6,amount=?7,status=CASE WHEN orders.status IN ('delivered','rto_in_transit','rto_delivered') THEN orders.status ELSE ?8 END,updated_at=?10`)
      .bind(orderId, String(order.id), orderNumber, String(customer.displayName || "Shopify customer"), String(customer.phone || address.phone || "") || null, String(order.displayFinancialStatus || "pending").toLowerCase() === "paid" ? "Prepaid" : "COD", Math.round(Number(money.amount ?? 0) * 100), status, String(order.createdAt || new Date().toISOString()), new Date().toISOString()).run();
    const tags = [...new Set((Array.isArray(order.tags) ? order.tags : []).map((tag) => String(tag).trim()).filter(Boolean))];
    await runtime.DB.prepare("DELETE FROM order_tags WHERE order_id=?1").bind(orderId).run();
    if (tags.length) {
      await runtime.DB.batch(tags.map((tag) => runtime.DB.prepare("INSERT INTO order_tags (id,order_id,tag) VALUES (?1,?2,?3)").bind(`otg_${randomHex(8)}`, orderId, tag)));
    }
    if (order.cancelledAt) {
      const cancellation = (order.cancellation ?? {}) as JsonRecord;
      const eventNodes = (((order.events ?? {}) as JsonRecord).nodes ?? []) as JsonRecord[];
      const cancellationEvent = eventNodes.find((event) => String(event.action) === "cancelled");
      const cancelledBy = cancellationEvent ? String(cancellationEvent.author || cancellationEvent.appTitle || (cancellationEvent.attributeToUser ? cancellationEvent.message : "") || "Shopify") : "Shopify";
      const reason = [order.cancelReason, cancellation.staffNote].filter(Boolean).map(String).join(" · ") || "No reason provided by Shopify";
      await runtime.DB.prepare("UPDATE orders SET cancellation_source='Shopify',cancellation_reason=?1,cancelled_by=?2,cancelled_at=?3 WHERE id=?4")
        .bind(reason, cancelledBy, String(order.cancelledAt), orderId).run();
    }
    const nodes = (((order.lineItems ?? {}) as JsonRecord).nodes ?? []) as JsonRecord[];
    const incomingIds: string[] = [];
    for (const line of nodes) {
      const variant = (line.variant ?? {}) as JsonRecord;
      const product = (variant.product ?? {}) as JsonRecord;
      const fallbackName = String(line.name || product.title || "").trim();
      const sku = String(line.sku || variant.sku || "").trim();
      let productId: string | null = null;
      let resolvedSku = sku;
      if (sku) {
        productId = `shpvar_${shopifyId(variant.id || sku)}`;
        await runtime.DB.prepare(`INSERT INTO products (id,shopify_variant_id,sku,name,variant,active) VALUES (?1,?2,?3,?4,?5,1)
          ON CONFLICT(sku) DO UPDATE SET shopify_variant_id=?2,name=?4,variant=?5`).bind(productId, String(variant.id || ""), sku, String(product.title || line.name || sku), String(variant.title || "Default")).run();
        const resolved = await runtime.DB.prepare("SELECT id FROM products WHERE sku=?1").bind(sku).first<{ id: string }>();
        productId = resolved?.id ?? productId;
      } else {
        const matched = await findProductMatchByName(fallbackName);
        if (matched) {
          productId = String(matched.id);
          resolvedSku = String(matched.sku);
        }
      }
      const lineId = `shpline_${shopifyId(line.id)}`;
      incomingIds.push(lineId);
      await runtime.DB.prepare(`INSERT INTO order_lines (id,order_id,product_id,sku,name,quantity,allocated_quantity) VALUES (?1,?2,?3,?4,?5,?6,0)
        ON CONFLICT(id) DO UPDATE SET product_id=?3,sku=?4,name=?5,quantity=?6`).bind(lineId, orderId, productId, resolvedSku || "INVALID-SKU", String(line.name || resolvedSku || "Unknown item"), Number(line.quantity || 0)).run();
      lineCount += 1;
    }
    if (incomingIds.length) {
      const placeholders = incomingIds.map((_, index) => `?${index + 2}`).join(",");
      await runtime.DB.prepare(`DELETE FROM order_lines WHERE order_id=?1 AND id NOT IN (${placeholders})`).bind(orderId, ...incomingIds).run();
    }
    await snapshotOrderRequirements(orderId, null, true, true, true);
    orderIds.push(orderId);
  }
  await reallocateComponents();
  await runtime.DB.prepare(`INSERT INTO integration_sync_cursors(provider,cursor_value,full_backfill_complete,last_success_at,last_error,updated_at)
    VALUES('shopify',?1,1,?1,NULL,?1) ON CONFLICT(provider) DO UPDATE SET cursor_value=?1,full_backfill_complete=1,last_success_at=?1,last_error=NULL,updated_at=?1`).bind(syncStartedAt).run();
  return { orders: orders.length, lines: lineCount, orderIds, mode: incrementalSince ? "incremental" : "full" };
}

export async function syncShiprocketOpenOrders() {
  await ensureDatabase();
  const runtime = getEnv();
  const syncStartedAt = new Date().toISOString();
  const cursor = await runtime.DB.prepare("SELECT cursor_value,full_backfill_complete,last_success_at FROM integration_sync_cursors WHERE provider='shiprocket'").first<{ cursor_value: string | null; full_backfill_complete: number; last_success_at: string | null }>();
  const continuingBackfill = !Number(cursor?.full_backfill_complete);
  let resumePage = 1;
  if (continuingBackfill && cursor?.cursor_value) {
    try { resumePage = Math.max(1, Number((JSON.parse(cursor.cursor_value) as { page?: unknown }).page) || 1); }
    catch { resumePage = 1; }
  }
  const cutoff = !continuingBackfill && cursor?.last_success_at ? new Date(cursor.last_success_at).getTime() - 86_400_000 * 3 : null;
  const importedIds = new Set<string>();
  let page = resumePage; let fetched = 0; let pagesProcessed = 0;
  // A scheduled Worker has a finite execution budget. Persist progress rather
  // than abandoning a large first backfill mid-run; the next cron resumes at
  // the following page until the provider's complete result set is covered.
  const pagesPerRun = 5;
  // Shiprocket does not guarantee that the API's page order is strictly
  // chronological. Walk every page it advertises across resumable runs: an
  // abandoned ceiling here would silently leave older open orders absent.
  console.log(`[Sync Debug] Starting sync. cutoff=${cutoff ? new Date(cutoff).toISOString() : 'none'}`);
  while (pagesProcessed < pagesPerRun) {
    const url = new URL("https://apiv2.shiprocket.in/v1/external/orders");
    url.searchParams.set("per_page", "100"); url.searchParams.set("page", String(page));
    const response = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${await shiprocketToken()}`, accept: "application/json" } }, 25_000);
    const payload = await response.json() as { data?: JsonRecord[]; meta?: { pagination?: { total_pages?: number } } };
    if (!response.ok) throw new Error(`Shiprocket order import failed (${response.status})`);
    const rows = payload.data ?? [];
    pagesProcessed += 1;
    console.log(`[Sync Debug] Fetched page ${page}. rows=${rows.length}, total_pages=${payload.meta?.pagination?.total_pages}`);
    for (const order of rows) {
      const updated = new Date(String(order.updated_at || order.updated_on || order.channel_created_at || order.created_at || 0)).getTime();
      if (cutoff === null || !Number.isFinite(updated) || updated >= cutoff) {
        const orderId = await upsertShiprocketOrder(order);
        importedIds.add(orderId); fetched += 1;
      }
    }
    const totalPages = Number(payload.meta?.pagination?.total_pages ?? 0);
    if ((Number.isFinite(totalPages) && totalPages > 0 && page >= totalPages) || rows.length < 100) {
      console.log(`[Sync Debug] Completed Shiprocket pagination at page ${page}. totalPages=${totalPages}, rows.length=${rows.length}`);
      await reallocateComponents();
      await runtime.DB.prepare(`INSERT INTO integration_sync_cursors(provider,cursor_value,full_backfill_complete,last_success_at,last_error,updated_at)
        VALUES('shiprocket',?1,1,?1,NULL,?1) ON CONFLICT(provider) DO UPDATE SET cursor_value=?1,full_backfill_complete=1,last_success_at=?1,last_error=NULL,updated_at=?1`).bind(syncStartedAt).run();
      return { checked: fetched, matched: importedIds.size, imported: importedIds.size, orderIds: [...importedIds], mode: cutoff === null ? "full" : "incremental", complete: true };
    }
    page += 1;
    // Commit progress after every provider page. If the Worker or database
    // connection is interrupted, the next cron resumes here instead of
    // repeatedly starting the entire Shiprocket backfill from page one.
    await runtime.DB.prepare(`INSERT INTO integration_sync_cursors(provider,cursor_value,full_backfill_complete,last_success_at,last_error,updated_at)
      VALUES('shiprocket',?1,0,NULL,NULL,?2) ON CONFLICT(provider) DO UPDATE SET cursor_value=?1,full_backfill_complete=0,last_error=NULL,updated_at=?2`)
      .bind(JSON.stringify({ page, startedAt: syncStartedAt }), new Date().toISOString()).run();
  }
  await reallocateComponents();
  await runtime.DB.prepare(`INSERT INTO integration_sync_cursors(provider,cursor_value,full_backfill_complete,last_success_at,last_error,updated_at)
    VALUES('shiprocket',?1,0,NULL,NULL,?2) ON CONFLICT(provider) DO UPDATE SET cursor_value=?1,full_backfill_complete=0,last_error=NULL,updated_at=?2`).bind(JSON.stringify({ page, startedAt: syncStartedAt }), syncStartedAt).run();
  return { checked: fetched, matched: importedIds.size, imported: importedIds.size, orderIds: [...importedIds], mode: "full-backfill", complete: false, nextPage: page };
}

export async function reconcileRecentShiprocketOrders(windowDays = 30, limit = 500) {
  await ensureDatabase();
  const runtime = getEnv();
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const candidates = await runtime.DB.prepare(`SELECT id,order_number FROM orders
    WHERE (shiprocket_order_id IS NOT NULL OR awb IS NOT NULL OR current_status IN ('MANIFESTED','LABEL_PRINTED','PICKUP_SCHEDULED','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','AUTO_CANCEL_RISK','RTO_INITIATED','RTO_IN_TRANSIT'))
      AND (created_at>=?1 OR updated_at>=?1)
      AND status NOT IN ('cancelled','delivered','rto_delivered')
    ORDER BY updated_at DESC
    LIMIT ?2`).bind(cutoff, limit).all<{ id: string; order_number: string }>();
  const changedOrderIds = new Set<string>();
  let checked = 0;
  for (const candidate of candidates.results) {
    checked += 1;
    const match = await lookupShiprocketOrder(String(candidate.order_number));
    if (!match) continue;
    await syncOrderFromShiprocket(String(candidate.id));
    changedOrderIds.add(String(candidate.id));
  }
  return { checked, changed: changedOrderIds.size, orderIds: [...changedOrderIds] };
}

async function upsertShiprocketOrder(order: JsonRecord) {
  const runtime = getEnv();
  const snapshot = extractShiprocketSnapshot(order);
  const externalId = snapshot.shiprocketOrderId || randomHex(8);
  const orderNumber = String(order.channel_order_id || `#SR-${externalId}`);
  const existing = await runtime.DB.prepare("SELECT id,awb,tracking_status FROM orders WHERE shiprocket_order_id=?1 OR LTRIM(order_number,'#')=?2 ORDER BY shopify_order_id IS NOT NULL DESC LIMIT 1").bind(externalId, orderNumber.replace(/^#/, "")).first<{ id: string; awb: string | null; tracking_status: string | null }>();
  const orderId = existing?.id ?? `sr_${externalId}`;
  let status = snapshot.status;
  let tracking = snapshot.trackingStatus;
  let currentStatus = snapshot.currentStatus;
  const awbWasRemoved = Boolean(existing?.awb && !snapshot.awb);
  if (awbWasRemoved || existing?.tracking_status === "cancelled_after_awb") {
    status = "cancelled";
    tracking = "cancelled_after_awb";
    currentStatus = "SHIPMENT_AUTO_CANCELLED";
  }
  await runtime.DB.prepare(`INSERT INTO orders (id,order_number,customer_name,customer_phone,payment_method,amount,status,current_status,shiprocket_order_id,shipment_id,awb,courier,tracking_status,rto_eta,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
    ON CONFLICT(id) DO UPDATE SET customer_name=?3,customer_phone=?4,payment_method=?5,amount=?6,status=?7,current_status=?8,shiprocket_order_id=?9,shipment_id=?10,awb=COALESCE(?11,orders.awb),courier=COALESCE(?12,orders.courier),tracking_status=?13,rto_eta=COALESCE(?14,orders.rto_eta),updated_at=?16`)
    .bind(orderId, orderNumber, String(order.customer_name || "Customer"), String(order.customer_phone || order.customer_phone_unmasked || "") || null, String(order.payment_method || "").toLowerCase().includes("cod") ? "COD" : "Prepaid", Math.round(Number(order.total_order_value ?? order.total ?? 0) * 100), status, currentStatus, externalId, snapshot.shiprocketShipmentId, snapshot.awb, snapshot.courier, tracking, snapshot.rtoEta, snapshot.createdAt, snapshot.updatedAt).run();
  if (status === "cancelled") {
    const shipment = Array.isArray(order.shipments) ? order.shipments[0] as JsonRecord | undefined : undefined;
    const reason = String(order.cancellation_reason || order.cancel_reason || order.reason || shipment?.cancellation_reason || shipment?.reason || (awbWasRemoved ? "AWB was cancelled or removed after generation" : "No reason provided by Shiprocket"));
    const cancelledBy = String(order.cancelled_by || order.updated_by || shipment?.cancelled_by || "Shiprocket");
    await runtime.DB.prepare("UPDATE orders SET cancellation_source='Shiprocket',cancellation_reason=?1,cancelled_by=?2,cancelled_at=COALESCE(cancelled_at,?3) WHERE id=?4")
      .bind(reason, cancelledBy, String(order.cancelled_at || order.updated_at || snapshot.updatedAt), orderId).run();
  }
  await upsertShipmentRecord(orderId, { ...snapshot, trackingStatus: tracking, currentStatus, status });
  if (snapshot.awb) await runtime.DB.prepare("UPDATE shipment_events SET order_id=?1 WHERE order_id IS NULL AND awb=?2").bind(orderId, String(snapshot.awb)).run();
  const products = Array.isArray(order.products) ? order.products as JsonRecord[] : [];
  const lineIds: string[] = [];
  const productSkuCache = new Map<string, string>();
  for (const product of products) {
    const productName = String(product.name || "").trim();
    const sku = String(product.channel_sku || product.sku || "").trim();
    let productId: string | null = null;
    let resolvedSku = sku;
    if (sku) {
      if (productSkuCache.has(sku)) {
        productId = productSkuCache.get(sku) ?? null;
      } else {
        const known = await runtime.DB.prepare("SELECT id FROM products WHERE sku=?1").bind(sku).first<{ id: string }>();
        productId = known?.id ?? `srprd_${String(product.product_id || product.id || randomHex(8))}`;
        if (!known) await runtime.DB.prepare("INSERT INTO products (id,sku,name,variant,active) VALUES (?1,?2,?3,'Default',1)").bind(productId, sku, String(product.name || sku)).run();
        productSkuCache.set(sku, productId);
      }
    } else {
      const matched = await findProductMatchByName(productName);
      if (matched) {
        productId = String(matched.id);
        resolvedSku = String(matched.sku);
      }
    }
    const lineId = `srline_${String(product.id || product.channel_order_product_id || randomHex(8))}`;
    lineIds.push(lineId);
    await runtime.DB.prepare(`INSERT INTO order_lines (id,order_id,product_id,sku,name,quantity,allocated_quantity) VALUES (?1,?2,?3,?4,?5,?6,0)
      ON CONFLICT(id) DO UPDATE SET product_id=?3,sku=?4,name=?5,quantity=?6`).bind(lineId, orderId, productId, resolvedSku || "INVALID-SKU", String(product.name || resolvedSku || "Unknown item"), Number(product.quantity || 0)).run();
  }
  if (lineIds.length) {
    const placeholders = lineIds.map((_, index) => `?${index + 2}`).join(",");
    await runtime.DB.prepare(`DELETE FROM order_lines WHERE order_id=?1 AND id NOT IN (${placeholders})`).bind(orderId, ...lineIds).run();
  }
  if (status === "rto_delivered") await runtime.DB.prepare("INSERT INTO rto_tasks (id,order_id,status,created_at) VALUES (?1,?2,'qc-pending',?3) ON CONFLICT(id) DO NOTHING").bind(`rto_${orderId}`, orderId, snapshot.updatedAt).run();
  if (!isDispatched(status, tracking) && status !== "cancelled") {
    await snapshotOrderRequirements(orderId, null, true, true, true);
  }
  return orderId;
}

export async function upsertShopifyWebhookOrder(payload: JsonRecord) {
  await ensureDatabase();
  const runtime = getEnv();
  const shopifyOrderId = `gid://shopify/Order/${String(payload.id ?? "")}`;
  const orderNumber = String(payload.name || `#${payload.order_number || payload.id}`);
  const existing = await runtime.DB.prepare("SELECT id FROM orders WHERE shopify_order_id=?1 OR LTRIM(order_number,'#')=?2 ORDER BY shopify_order_id IS NOT NULL DESC LIMIT 1").bind(shopifyOrderId, orderNumber.replace(/^#/, "")).first<{ id: string }>();
  const orderId = existing?.id ?? `shpord_${String(payload.id || randomHex(8))}`;
  const customer = (payload.customer ?? {}) as JsonRecord;
  const shipping = (payload.shipping_address ?? {}) as JsonRecord;
  const shopifyCustomerId = customer.id ? `gid://shopify/Customer/${String(customer.id)}` : null;
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(" ") || String(shipping.name || "Shopify customer");
  const status = payload.cancelled_at ? "cancelled" : "open";
  const tags = String(payload.tags || "").split(",").map((item) => item.trim()).filter(Boolean);
  
  const address = String(shipping.address1 || "Address not provided");
  const city = String(shipping.city || "City");
  const state = String(shipping.province || "State");
  const pincode = String(shipping.zip || "000000");
  const country = String(shipping.country || "India");

  await runtime.DB.prepare(`INSERT INTO orders (id,shopify_order_id,shopify_customer_id,order_number,customer_name,customer_phone,payment_method,amount,status,created_at,updated_at,shipping_address,shipping_city,shipping_state,shipping_pincode,shipping_country)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
    ON CONFLICT(id) DO UPDATE SET shopify_order_id=?2,shopify_customer_id=?3,customer_name=?5,customer_phone=?6,payment_method=?7,amount=?8,status=CASE WHEN orders.status IN ('delivered','rto_in_transit','rto_delivered') THEN orders.status ELSE ?9 END,updated_at=?11,shipping_address=?12,shipping_city=?13,shipping_state=?14,shipping_pincode=?15,shipping_country=?16`)
    .bind(orderId, shopifyOrderId, shopifyCustomerId, orderNumber, customerName, String(payload.phone || customer.phone || shipping.phone || "") || null, String(payload.financial_status || "").toLowerCase() === "paid" ? "Prepaid" : "COD", Math.round(Number(payload.total_price || 0) * 100), status, String(payload.created_at || new Date().toISOString()), new Date().toISOString(), address, city, state, pincode, country).run();
  await runtime.DB.prepare("DELETE FROM order_tags WHERE order_id=?1").bind(orderId).run();
  if (tags.length) {
    await runtime.DB.batch(tags.map((tag) => runtime.DB.prepare("INSERT INTO order_tags (id,order_id,tag) VALUES (?1,?2,?3)").bind(`otg_${randomHex(8)}`, orderId, tag)));
  }
  if (payload.cancelled_at) {
    const cancelledBy = payload.user_id ? `Shopify staff #${String(payload.user_id)}` : payload.app_id ? `Shopify app #${String(payload.app_id)}` : "Shopify";
    await runtime.DB.prepare("UPDATE orders SET cancellation_source='Shopify',cancellation_reason=?1,cancelled_by=?2,cancelled_at=?3 WHERE id=?4")
      .bind(String(payload.cancel_reason || "No reason provided by Shopify"), cancelledBy, String(payload.cancelled_at), orderId).run();
  }
  const lines = Array.isArray(payload.line_items) ? payload.line_items as JsonRecord[] : [];
  const ids: string[] = [];
  for (const line of lines) {
    const sku = String(line.sku || "").trim();
    let productId: string | null = null;
    if (sku) {
      const product = await runtime.DB.prepare("SELECT id FROM products WHERE sku=?1").bind(sku).first<{ id: string }>();
      productId = product?.id ?? `shpvar_${String(line.variant_id || randomHex(8))}`;
      if (!product) await runtime.DB.prepare("INSERT INTO products (id,shopify_variant_id,sku,name,variant,active) VALUES (?1,?2,?3,?4,?5,1)").bind(productId, line.variant_id ? `gid://shopify/ProductVariant/${line.variant_id}` : null, sku, String(line.title || sku), String(line.variant_title || "Default")).run();
    }
    const id = `shpline_${String(line.id || randomHex(8))}`; ids.push(id);
    await runtime.DB.prepare(`INSERT INTO order_lines (id,order_id,product_id,sku,name,quantity,allocated_quantity) VALUES (?1,?2,?3,?4,?5,?6,0)
      ON CONFLICT(id) DO UPDATE SET product_id=?3,sku=?4,name=?5,quantity=?6`).bind(id, orderId, productId, sku || "INVALID-SKU", String(line.name || line.title || sku || "Unknown item"), Number(line.quantity || 0)).run();
  }
  if (ids.length) {
    const placeholders = ids.map((_, index) => `?${index + 2}`).join(",");
    await runtime.DB.prepare(`DELETE FROM order_lines WHERE order_id=?1 AND id NOT IN (${placeholders})`).bind(orderId, ...ids).run();
  }
  await snapshotOrderRequirements(orderId, null, true, true);
  await reallocateComponents();
  return orderId;
}

export async function manifestOrderToShiprocket(orderId: string, actorId: string) {
  await ensureDatabase();
  const runtime = getEnv();

  type ManifestOrderRow = {
    id: string;
    order_number: string;
    created_at: string;
    customer_name: string;
    customer_phone: string | null;
    shipping_address: string | null;
    shipping_city: string | null;
    shipping_pincode: string | null;
    shipping_state: string | null;
    shipping_country: string | null;
    amount: number;
    payment_method: string;
    current_status: string | null;
  };

  type ManifestLineRow = {
    name: string;
    sku: string;
    quantity: number;
  };

  const order = await runtime.DB.prepare(
    "SELECT id,order_number,created_at,customer_name,customer_phone,shipping_address,shipping_city,shipping_pincode,shipping_state,shipping_country,amount,payment_method,current_status FROM orders WHERE id=?1",
  ).bind(orderId).first<ManifestOrderRow>();
  if (!order) throw new Error("Order not found");

  const lines = await runtime.DB.prepare(
    "SELECT name,sku,quantity FROM order_lines WHERE order_id=?1",
  ).bind(orderId).all<ManifestLineRow>();
  if (!lines.results.length) throw new Error("Order has no line items");
  const lineCount = lines.results.length;

  const payload = {
    order_id: order.order_number,
    order_date: new Date(order.created_at).toISOString().split("T")[0],
    pickup_location: "Primary",
    billing_customer_name: order.customer_name,
    billing_last_name: "",
    billing_address: order.shipping_address || "Address not provided",
    billing_city: order.shipping_city || "City",
    billing_pincode: order.shipping_pincode || "000000",
    billing_state: order.shipping_state || "State",
    billing_country: order.shipping_country || "India",
    billing_email: "customer@example.com",
    billing_phone: (order.customer_phone || "9999999999").replace(/\D/g, "").slice(-10),
    shipping_is_billing: true,
    order_items: lines.results.map((line) => ({
      name: line.name,
      sku: line.sku,
      units: line.quantity,
      selling_price: Math.round(order.amount / 100 / lineCount),
    })),
    payment_method: order.payment_method === "COD" ? "COD" : "Prepaid",
    sub_total: Math.round(order.amount / 100),
    length: 10,
    breadth: 10,
    height: 10,
    weight: 0.5
  };
  
  try {
  const token = await shiprocketToken();
  const response = await fetchWithTimeout("https://apiv2.shiprocket.in/v1/external/orders/create/adhoc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok || !result.shipment_id || !result.awb_code) {
    const errorMsg = result.message || JSON.stringify(result);
    throw new Error(`Shiprocket manifest failed: ${errorMsg}`);
  }
  
  const now = new Date().toISOString();
  
  // Only display an SLA deadline when the courier maps to a configured rule.
  const courierName = String(result.courier_name || "Unknown Courier");
  const sla = courierName === "Unknown Courier" ? null : await runtime.DB.prepare(`SELECT auto_cancel_days FROM courier_sla
    WHERE LOWER(?1)=LOWER(courier_name) OR LOWER(?1) LIKE '%' || LOWER(courier_name) || '%' OR LOWER(courier_name) LIKE '%' || LOWER(?1) || '%'
    ORDER BY LENGTH(courier_name) DESC LIMIT 1`).bind(courierName).first<{ auto_cancel_days: number }>();
  const autoCancelDays = sla?.auto_cancel_days ?? null;
  const autoCancelDeadline = autoCancelDays === null ? null : new Date(Date.now() + autoCancelDays * 86_400_000).toISOString();
  
  const shipmentId = `shp_${randomHex(8)}`;
  
  await runtime.DB.batch([
    runtime.DB.prepare(`INSERT INTO shipments (id, order_id, attempt_number, shiprocket_order_id, shiprocket_shipment_id, awb_number, courier_name, courier_auto_cancel_days, auto_cancel_deadline, status, manifested_at, is_active)
      VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, 'MANIFESTED', ?9, 1)`)
      .bind(shipmentId, orderId, result.order_id, result.shipment_id, result.awb_code, courierName, autoCancelDays, autoCancelDeadline, now),
      
    runtime.DB.prepare(`UPDATE orders SET status='manifest_generated', current_status='MANIFESTED', shiprocket_order_id=?1, shipment_id=?2, awb=?3, courier=?4, tracking_status='manifest_generated', updated_at=?5 WHERE id=?6`)
      .bind(result.order_id, result.shipment_id, result.awb_code, courierName, now, orderId),
      
    runtime.DB.prepare(`INSERT INTO order_status_log (id, order_id, from_status, to_status, changed_by, reason, created_at)
      VALUES (?1, ?2, ?3, 'MANIFESTED', ?4, 'Order manifested via Shiprocket API', ?5)`)
      .bind(`log_${randomHex(8)}`, orderId, order.current_status, actorId, now)
  ]);

  await broadcastOrderUpdate(orderId, "manifest.completed");
  
  return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Shiprocket manifest failed";
    const now = new Date().toISOString();
    await runtime.DB.prepare("UPDATE orders SET stuck_reason=?1,stuck_since=COALESCE(stuck_since,?2),stuck_notes=?1,updated_at=?2 WHERE id=?3")
      .bind(detail, now, orderId).run();
    throw error;
  }
}

export async function fetchShiprocketLabel(orderId: string, actorId: string) {
  await ensureDatabase();
  const runtime = getEnv();
  if (!runtime.LABELS) throw new Error("Label storage is not configured");

  const order = await runtime.DB.prepare("SELECT order_number,shiprocket_order_id,shipment_id,label_key FROM orders WHERE id=?1 LIMIT 1")
    .bind(orderId)
    .first<{ order_number: string; shiprocket_order_id: string | null; shipment_id: string | null; label_key: string | null }>();
  if (!order) throw new Error("Order not found");
  let shipmentId = order.shipment_id ? Number(order.shipment_id) : NaN;
  if (!Number.isFinite(shipmentId) && order.shiprocket_order_id) {
    const detailsResponse = await fetchWithTimeout(`https://apiv2.shiprocket.in/v1/external/orders/show/${order.shiprocket_order_id}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await shiprocketToken()}`,
      },
    });
    const detailsPayload = await detailsResponse.json() as JsonRecord;
    if (detailsResponse.ok) {
      const resolvedShipmentId = Number(
        (detailsPayload as Record<string, unknown>).shipment_id
        ?? (detailsPayload as Record<string, unknown>).shipmentId
        ?? ((detailsPayload.data as Record<string, unknown> | undefined)?.shipment_id)
        ?? ((detailsPayload.data as Record<string, unknown> | undefined)?.shipmentId),
      );
      if (Number.isFinite(resolvedShipmentId)) shipmentId = resolvedShipmentId;
    }
  }
  if (!Number.isFinite(shipmentId)) throw new Error("Shiprocket shipment id is missing for this order. Create or sync the shipment first.");

  const response = await fetchWithTimeout("https://apiv2.shiprocket.in/v1/external/courier/generate/label", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await shiprocketToken()}`,
    },
    body: JSON.stringify({ shipment_id: [shipmentId] }),
  });
  const payload = await response.json() as JsonRecord;
  if (!response.ok) {
    const message = typeof payload.message === "string" ? payload.message : JSON.stringify(payload).slice(0, 300);
    throw new Error(`Shiprocket label generation failed (${response.status}): ${message}`);
  }

  const labelUrl = findFirstUrl(payload);
  if (!labelUrl && order.shiprocket_order_id) {
    const detailsResponse = await fetchWithTimeout(`https://apiv2.shiprocket.in/v1/external/orders/show/${order.shiprocket_order_id}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await shiprocketToken()}`,
      },
    });
    const detailsPayload = await detailsResponse.json() as JsonRecord;
    const fallbackLabelUrl = findFirstUrl(detailsPayload);
    if (!fallbackLabelUrl) throw new Error("Shiprocket generated the label but did not return a downloadable PDF URL");
    const fallbackBytesResponse = await fetchWithTimeout(fallbackLabelUrl, { headers: { accept: "application/pdf" } });
    if (!fallbackBytesResponse.ok) throw new Error(`Shiprocket label download failed (${fallbackBytesResponse.status})`);
    const fallbackBytes = await fallbackBytesResponse.arrayBuffer();
    const fallbackSize = fallbackBytes.byteLength;
    if (!fallbackSize) throw new Error("Shiprocket returned an empty label file");
    const now = new Date().toISOString();
    const key = `labels/${orderId}/${Date.now()}-shiprocket-label.pdf`;
    await runtime.LABELS.put(key, fallbackBytes, {
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: `attachment; filename="${String(order.order_number).replace(/[^a-zA-Z0-9._-]/g, "-")}-label.pdf"`,
      },
    });
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO labels (id,order_id,object_key,file_name,size,uploaded_by,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)")
        .bind(`lbl_${randomHex(9)}`, orderId, key, `${String(order.order_number).replace(/[^a-zA-Z0-9._-]/g, "-")}-label.pdf`, fallbackSize, actorId, now),
      runtime.DB.prepare("UPDATE orders SET label_key=?1,shipment_id=COALESCE(shipment_id,?2),updated_at=?3 WHERE id=?4").bind(key, String(shipmentId), now, orderId),
    ]);
    await audit(actorId, "label.shiprocket-fetched", "order", orderId, fallbackLabelUrl);
    return { key, size: fallbackSize };
  }
  if (!labelUrl) throw new Error("Shiprocket did not return a label URL");

  const labelResponse = await fetchWithTimeout(labelUrl, { headers: { accept: "application/pdf" } });
  if (!labelResponse.ok) throw new Error(`Shiprocket label download failed (${labelResponse.status})`);
  const bytes = await labelResponse.arrayBuffer();
  const size = bytes.byteLength;
  if (!size) throw new Error("Shiprocket returned an empty label file");

  const now = new Date().toISOString();
  const key = `labels/${orderId}/${Date.now()}-shiprocket-label.pdf`;
  await runtime.LABELS.put(key, bytes, {
    httpMetadata: {
      contentType: "application/pdf",
      contentDisposition: `attachment; filename="${String(order.order_number).replace(/[^a-zA-Z0-9._-]/g, "-")}-label.pdf"`,
    },
  });
  await runtime.DB.batch([
    runtime.DB.prepare("INSERT INTO labels (id,order_id,object_key,file_name,size,uploaded_by,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)")
      .bind(`lbl_${randomHex(9)}`, orderId, key, `${String(order.order_number).replace(/[^a-zA-Z0-9._-]/g, "-")}-label.pdf`, size, actorId, now),
    runtime.DB.prepare("UPDATE orders SET label_key=?1,shipment_id=COALESCE(shipment_id,?2),updated_at=?3 WHERE id=?4").bind(key, String(shipmentId), now, orderId),
  ]);
  await audit(actorId, "label.shiprocket-fetched", "order", orderId, labelUrl);
  return { key, size };
}

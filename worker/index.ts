/** Cloudflare Worker entry point for Satmi Operations & Inventory. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { authenticateRequest } from "../lib/auth";
import { broadcastOrderUpdate } from "../lib/realtime";
import { OrderEventsHub } from "./order-events";
import { getPostgresDatabase, type AppDatabase } from "../lib/postgres";
import { audit, ensureDatabase, getEnv } from "../lib/database";
import { backfillInvalidSkuOrderLines, reconcileRecentShiprocketOrders, syncShiprocketOpenOrders, syncShopifyOrders } from "../lib/integrations";
import { assignOrderToLongTermCampaign } from "../lib/state";

interface Env {
  ASSETS: Fetcher;
  SUPABASE_DATABASE_URL: string;
  HYPERDRIVE?: { connectionString: string };
  ORDER_EVENTS: DurableObjectNamespace;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export { OrderEventsHub };

export async function processAutoCancelRiskCheck(
  db: AppDatabase,
  notifyOrderChange?: (orderId: string) => Promise<void>,
) {
  const now = new Date().toISOString();
  // Find active shipments that have passed their auto_cancel_deadline
  const atRisk = await db.prepare(`SELECT id, order_id, status FROM shipments 
    WHERE is_active=1 
      AND auto_cancel_deadline IS NOT NULL 
      AND auto_cancel_deadline <= ?1 
      AND status NOT IN ('AUTO_CANCEL_RISK', 'SHIPMENT_AUTO_CANCELLED', 'DELIVERED', 'CANCELED', 'RTO_RECEIVED', 'RTO_RESTOCKED')`)
    .bind(now)
    .all<{ id: string; order_id: string; status: string }>();

  for (const shipment of atRisk.results) {
    const logId = `log_${crypto.randomUUID().slice(0, 8)}`;
    await db.batch([
      db.prepare(`UPDATE shipments SET status='AUTO_CANCEL_RISK' WHERE id=?1`).bind(shipment.id),
      db.prepare(`UPDATE orders SET current_status='AUTO_CANCEL_RISK', status='auto_cancel_risk', stuck_reason='Courier Auto-Cancel SLA Deadline Reached', stuck_since=?1, updated_at=?1 WHERE id=?2`)
        .bind(now, shipment.order_id),
      db.prepare(`INSERT INTO order_status_log (id, order_id, from_status, to_status, changed_by, reason, created_at) VALUES (?1, ?2, ?3, 'AUTO_CANCEL_RISK', 'system', 'Courier auto-cancel SLA deadline reached', ?4)`)
        .bind(logId, shipment.order_id, shipment.status, now),
    ]);
    if (notifyOrderChange) await notifyOrderChange(shipment.order_id);
  }
}

async function processScheduledIntegrationSync() {
  await ensureDatabase();
  const db = getEnv().DB;
  const now = new Date().toISOString();
  const changedOrderIds = new Set<string>();
  const results: string[] = [];

  try {
    await db.prepare("UPDATE integration_state SET status='syncing',detail='Scheduled Shopify order sync in progress',updated_at=?1 WHERE provider='shopify'").bind(now).run();
    const shopify = await syncShopifyOrders();
    const backfill = await backfillInvalidSkuOrderLines();
    for (const orderId of shopify.orderIds) await assignOrderToLongTermCampaign(orderId);
    shopify.orderIds.forEach((id) => changedOrderIds.add(id));
    backfill.orderIds.forEach((id) => changedOrderIds.add(id));
    await db.prepare("UPDATE integration_state SET status='connected',detail=?1,last_synced_at=?2,updated_at=?2 WHERE provider='shopify'").bind(`${shopify.orders} orders reconciled · ${shopify.mode} scheduled sync`, now).run();
    results.push(`Shopify ${shopify.orders}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Shopify scheduled sync failed";
    await db.prepare("UPDATE integration_state SET status='action-required',detail=?1,updated_at=?2 WHERE provider='shopify'").bind(detail, now).run();
    results.push("Shopify failed");
    console.error("Scheduled Shopify sync failed", detail);
  }

  try {
    await db.prepare("UPDATE integration_state SET status='syncing',detail='Scheduled Shiprocket order sync in progress',updated_at=?1 WHERE provider='shiprocket'").bind(now).run();
    const shiprocket = await syncShiprocketOpenOrders();
    const reconciliation = shiprocket.complete ? await reconcileRecentShiprocketOrders() : { checked: 0, changed: 0, orderIds: [] as string[] };
    shiprocket.orderIds.forEach((id) => changedOrderIds.add(id));
    reconciliation.orderIds.forEach((id) => changedOrderIds.add(id));
    await db.prepare("UPDATE integration_state SET status=?1,detail=?2,last_synced_at=?3,updated_at=?3 WHERE provider='shiprocket'").bind(shiprocket.complete ? "connected" : "syncing", `${shiprocket.imported} orders reconciled · ${shiprocket.mode} scheduled sync${shiprocket.complete ? ` · ${reconciliation.changed} shipment refreshes` : ` · next page ${shiprocket.nextPage}`}`, now).run();
    results.push(`Shiprocket ${shiprocket.imported}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Shiprocket scheduled sync failed";
    await db.prepare("UPDATE integration_state SET status='error',detail=?1,updated_at=?2 WHERE provider='shiprocket'").bind(detail, now).run();
    results.push("Shiprocket failed");
    console.error("Scheduled Shiprocket sync failed", detail);
  }

  await audit(null, "integrations.scheduled-sync", "system", "integrations", results.join(" · "));
  for (const orderId of changedOrderIds) await broadcastOrderUpdate(orderId, "cron.integration-sync");
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (url.pathname === "/api/events") {
      const user = await authenticateRequest(request);
      if (!user) return new Response("Unauthorized", { status: 401 });
      if (user.mustChangePassword) return new Response("Password change required", { status: 428 });

      const stub = env.ORDER_EVENTS.get(env.ORDER_EVENTS.idFromName("satmi-order-events"));
      const target = new URL("https://order-events.internal/connect");
      target.searchParams.set("userId", user.id);
      target.searchParams.set("role", user.role);
      return stub.fetch(target.toString(), {
        headers: { accept: "text/event-stream" },
      });
    }

    return handler.fetch(request, env, ctx);
  },

  async scheduled(event: { scheduledTime: number; cron: string }, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await processAutoCancelRiskCheck(getPostgresDatabase(env.HYPERDRIVE?.connectionString || env.SUPABASE_DATABASE_URL), (orderId) => broadcastOrderUpdate(orderId, "cron.auto_cancel_risk"));
        await processScheduledIntegrationSync();
      })(),
    );
  }
};

export default worker;

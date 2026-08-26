import { audit, ensureDatabase, getEnv } from "@/lib/database";
import { upsertShopifyWebhookOrder, verifyHmac } from "@/lib/integrations";
import { randomHex, sha256 } from "@/lib/crypto";
import { broadcastOrderUpdate } from "@/lib/realtime";
import { assignOrderToLongTermCampaign } from "@/lib/state";

const highRtoTags = new Set(["high", "rto_prediction_high"]);

async function recordWebhookDiagnostic(action: string, detail: string) {
  try { await audit(null, action, "webhook", "shopify", detail); }
  catch (error) { console.error("Could not persist Shopify webhook diagnostic", error); }
}

function shopifyTags(value: unknown) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
}

export async function POST(request: Request) {
  const raw = await request.text();
  const runtime = getEnv();
  const signature = request.headers.get("x-shopify-hmac-sha256") ?? "";
  const topic = request.headers.get("x-shopify-topic") ?? "unknown";
  const webhookId = request.headers.get("x-shopify-webhook-id") ?? `shopify_${await sha256(`${topic}:${raw}`)}`;
  let receiptClaimed = false;

  try {
    if (!runtime.SHOPIFY_CLIENT_SECRET) {
      await recordWebhookDiagnostic("webhook.shopify.rejected", "SHOPIFY_CLIENT_SECRET is not configured");
      return new Response("Shopify webhook is not configured", { status: 503 });
    }
    if (!await verifyHmac(raw, signature, runtime.SHOPIFY_CLIENT_SECRET)) {
      await recordWebhookDiagnostic("webhook.shopify.rejected", `${topic} rejected: invalid HMAC signature`);
      return new Response("Invalid signature", { status: 401 });
    }
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(raw) as Record<string, unknown>; }
    catch {
      await recordWebhookDiagnostic("webhook.shopify.rejected", `${topic} rejected: invalid JSON`);
      return Response.json({ error: "Invalid Shopify JSON payload" }, { status: 400 });
    }

    await ensureDatabase();
    const db = runtime.DB;
    const now = new Date().toISOString();
    const claim = await db.prepare("INSERT INTO webhook_receipts (id,provider,topic,received_at) VALUES (?1,'shopify',?2,?3) ON CONFLICT(id) DO NOTHING").bind(webhookId, topic, now).run();
    if (!claim.meta?.changes) {
      await recordWebhookDiagnostic("webhook.shopify.duplicate", `${topic} duplicate delivery ignored`);
      return new Response("OK");
    }
    receiptClaimed = true;

    if (["orders/create", "orders/updated", "orders/cancelled"].includes(topic)) {
      const orderId = await upsertShopifyWebhookOrder(payload);
      if (orderId && topic === "orders/create") {
      // Shiprocket Sense / heuristic scoring is deliberately deprecated. Shopify
      // order tags are the source of truth for routing, with exact tag matches
      // so tags such as "high-value" never false-positive as HIGH RTO.
      // const legacySenseScore = await getShiprocketSenseScore(payload);
      const tags = shopifyTags(payload.tags);
      const rtoRisk = tags.some((tag) => highRtoTags.has(tag)) ? "HIGH" : "LOW";
      const newStatus = rtoRisk === "LOW" ? "APPROVED" : "PENDING_CONFIRMATION";
      
      await db.batch([
        db.prepare(`UPDATE orders SET rto_risk=?1, rto_score=NULL, current_status=?2,
          status=CASE WHEN ?2='APPROVED' THEN 'approved' ELSE status END,
          confirmation_selected=CASE WHEN ?2='PENDING_CONFIRMATION' THEN 1 ELSE confirmation_selected END,
          confirmation_status=CASE WHEN ?2='PENDING_CONFIRMATION' THEN 'selected' ELSE confirmation_status END,
          updated_at=?3 WHERE id=?4`)
          .bind(rtoRisk, newStatus, now, orderId),
        db.prepare(`INSERT INTO order_status_log (id, order_id, from_status, to_status, changed_by, reason, created_at) VALUES (?1, ?2, 'INGESTED', ?3, 'shopify_webhook', ?4, ?5)`)
          .bind(`log_${randomHex(8)}`, orderId, newStatus, `Shopify order ingested with ${rtoRisk} RTO risk based on Shopify tags: ${tags.join(", ") || "none"}`, now),
      ]);
      }
      // upsertShopifyWebhookOrder already snapshots recipe requirements and
      // reallocates components. Keep the webhook path single-pass so Shopify
      // receives its acknowledgement promptly.
      if (orderId) {
        // Re-evaluate on tag updates as well as creates. Shopify frequently
        // applies risk tags after the initial order-create webhook.
        await assignOrderToLongTermCampaign(orderId);
        await broadcastOrderUpdate(orderId, `shopify.${topic.replace("/", ".")}`);
        await recordWebhookDiagnostic("webhook.shopify.processed", `${topic} processed for order ${orderId}`);
      }
    }
    return new Response("OK");
  } catch (error) {
    if (receiptClaimed) {
      try { await runtime.DB.prepare("DELETE FROM webhook_receipts WHERE id=?1").bind(webhookId).run(); }
      catch (cleanupError) { console.error("Could not release failed Shopify webhook claim", cleanupError); }
    }
    const detail = error instanceof Error ? error.message : "Unknown Shopify webhook error";
    await recordWebhookDiagnostic("webhook.shopify.failed", `${topic} failed: ${detail.slice(0, 300)}`);
    console.error("Shopify webhook processing failed", { webhookId, topic, detail });
    return Response.json({ error: "Shopify webhook processing failed", detail }, { status: 500 });
  }
}

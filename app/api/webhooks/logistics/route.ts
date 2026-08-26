import { audit, ensureDatabase, getEnv } from "@/lib/database";
import { applyShipmentTransition } from "@/lib/state";
import { reallocateComponents } from "@/lib/components";
import { randomHex, safeEqual, sha256 } from "@/lib/crypto";
import { broadcastOrderUpdate } from "@/lib/realtime";
import { normalizeShiprocketCurrentStatus, normalizeShiprocketOrderStatus, normalizeShiprocketTracking } from "@/lib/shipping";

async function recordWebhookDiagnostic(action: string, detail: string) {
  try { await audit(null, action, "webhook", "shiprocket", detail); }
  catch (error) { console.error("Could not persist Shiprocket webhook diagnostic", error); }
}

export async function POST(request: Request) {
  const runtime = getEnv();
  const configuredSecret = runtime.SHIPROCKET_WEBHOOK_SECRET?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  const suppliedSecret = (request.headers.get("x-api-key") ?? authorization.replace(/^Bearer\s+/i, "")).trim();
  // Shiprocket documents the optional webhook security token as x-api-key.
  // Accepting a Bearer envelope as well supports a reverse proxy without
  // weakening authentication.
  if (!configuredSecret) {
    await recordWebhookDiagnostic("webhook.shiprocket.rejected", "SHIPROCKET_WEBHOOK_SECRET is not configured");
    return new Response("Shiprocket webhook is not configured", { status: 503 });
  }
  if (!suppliedSecret || !safeEqual(suppliedSecret, configuredSecret)) {
    await recordWebhookDiagnostic("webhook.shiprocket.rejected", "Rejected: invalid webhook token");
    return new Response("Invalid Shiprocket webhook token", { status: 401 });
  }

  const raw = await request.text();
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw) as Record<string, unknown>; }
  catch {
    await recordWebhookDiagnostic("webhook.shiprocket.rejected", "Rejected: invalid JSON");
    return Response.json({ error: "Invalid Shiprocket JSON payload" }, { status: 400 });
  }
  const awb = String(payload.awb ?? payload.awb_code ?? payload.awb_number ?? "").trim();

  const statusCode = String(payload.shipment_status_id ?? payload.current_status_id ?? payload.status_code ?? "");
  const now = new Date().toISOString();
  const receiptId = request.headers.get("x-shiprocket-webhook-id") || `shiprocket_${await sha256(raw)}`;
  const sourceTime = String(payload.updated_at ?? payload.event_timestamp ?? payload.activity_date ?? now);
  const eventId = `sr_evt_${await sha256(`${awb}:${statusCode}:${sourceTime}`)}`;

  await ensureDatabase();
  const db = runtime.DB;
  const claim = await db.prepare("INSERT INTO webhook_receipts (id,provider,topic,received_at) VALUES (?1,'shiprocket',?2,?3) ON CONFLICT(id) DO NOTHING")
    .bind(receiptId, `status:${statusCode || "missing"}`, now).run();
  if (!claim.meta?.changes) {
    await recordWebhookDiagnostic("webhook.shiprocket.duplicate", `Duplicate status ${statusCode || "missing"} ignored`);
    return new Response("OK");
  }

  try {
    const nestedShipment = payload.shipment && typeof payload.shipment === "object" ? payload.shipment as Record<string, unknown> : null;
    const shiprocketShipmentId = String(payload.shipment_id ?? payload.sr_shipment_id ?? nestedShipment?.id ?? "");
    const shiprocketOrderId = String(payload.sr_order_id ?? payload.shiprocket_order_id ?? payload.order_id ?? payload.channel_order_id ?? "");
    const channelOrderNumber = String(payload.channel_order_id ?? payload.order_number ?? payload.order_id ?? "").replace(/^#/, "").trim().toUpperCase();
    const shipment = await db.prepare("SELECT * FROM shipments WHERE ((?1<>'' AND awb_number=?1) OR (?2<>'' AND shiprocket_shipment_id=?2)) AND is_active=1 LIMIT 1").bind(awb, shiprocketShipmentId).first<Record<string, unknown>>();
    const matchedOrder = await db.prepare(`SELECT id, current_status FROM orders WHERE (?1<>'' AND awb=?1) OR (?2<>'' AND shipment_id=?2) OR (?3<>'' AND shiprocket_order_id=?3) OR (?4<>'' AND normalized_order_number=?4) LIMIT 1`)
      .bind(awb, shiprocketShipmentId, shiprocketOrderId, channelOrderNumber).first<{ id: string; current_status: string }>();

    const trackingStatus = normalizeShiprocketTracking(statusCode || payload.current_status_id || payload.current_status || payload.activity || payload.status);
    const newStatus = normalizeShiprocketCurrentStatus(statusCode || payload.current_status_id || payload.current_status || payload.activity || payload.status);
    const orderStatus = normalizeShiprocketOrderStatus(statusCode || payload.current_status_id || payload.current_status || payload.activity || payload.status);
    if (trackingStatus === "pending") return Response.json({ ok: true, ignored: true, reason: "Unknown Shiprocket status" });
    // Acknowledge unmatched events so Shiprocket does not build a retry
    // backlog. Scheduled reconciliation can attach them once the order/AWB is
    // visible in the local channel cache.
    if (!matchedOrder) {
      await recordWebhookDiagnostic("webhook.shiprocket.unmatched", `Status ${statusCode || "missing"} has no local order match`);
      return Response.json({ ok: true, ignored: true, reason: "No matching local order" });
    }

    await db.prepare(`INSERT INTO tracking_events (id, shipment_id, order_id, event_tag, event_description, location, event_timestamp, received_at, raw_payload)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(id) DO NOTHING`)
      .bind(
        eventId,
        shipment?.id ? String(shipment.id) : null,
        matchedOrder.id,
        newStatus,
        String(payload.current_status ?? payload.activity ?? "Tracking update"),
        String(payload.location ?? payload.city ?? ""),
        sourceTime,
        now,
        raw
      ).run();

    if (awb) {
      await db.prepare(`INSERT INTO shipment_events (id,order_id,awb,status,status_code,courier,occurred_at,received_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
        ON CONFLICT(id) DO NOTHING`)
        .bind(`sev_${await sha256(`${awb}:${trackingStatus}:${sourceTime}`)}`, matchedOrder.id, awb, trackingStatus, statusCode || null, String(payload.courier_name ?? payload.courier ?? shipment?.courier_name ?? "") || null, sourceTime, now).run();
    }

    {
      const fromStatus = matchedOrder.current_status ?? "INGESTED";
      if (shipment?.id) {
        const isPickedUp = newStatus === "PICKED_UP";
        const isDelivered = newStatus === "DELIVERED";
        const isAutoCancelled = newStatus === "SHIPMENT_AUTO_CANCELLED";
        await db.prepare(`UPDATE shipments SET
          shiprocket_shipment_id=COALESCE(NULLIF(?1,''),shiprocket_shipment_id),
          awb_number=COALESCE(NULLIF(?2,''),awb_number),
          courier_name=COALESCE(NULLIF(?3,''),courier_name),
          status=?4,
          picked_up_at=CASE WHEN ?5=1 THEN COALESCE(picked_up_at, ?8) ELSE picked_up_at END,
          delivered_at=CASE WHEN ?6=1 THEN COALESCE(delivered_at, ?8) ELSE delivered_at END,
          auto_cancelled_at=CASE WHEN ?7=1 THEN COALESCE(auto_cancelled_at, ?8) ELSE auto_cancelled_at END
          WHERE id=?9`)
          .bind(shiprocketShipmentId, awb, String(payload.courier_name ?? payload.courier ?? shipment.courier_name ?? ""), newStatus, isPickedUp ? 1 : 0, isDelivered ? 1 : 0, isAutoCancelled ? 1 : 0, now, String(shipment.id)).run();
      }

      const statements = [
        db.prepare(`UPDATE orders SET current_status=?1,status=?2,tracking_status=?3,awb=COALESCE(NULLIF(?4,''),awb),courier=COALESCE(NULLIF(?5,''),courier),shipment_id=COALESCE(NULLIF(?6,''),shipment_id),shiprocket_order_id=COALESCE(NULLIF(?7,''),shiprocket_order_id),updated_at=?8 WHERE id=?9`)
          .bind(newStatus, orderStatus, trackingStatus, awb, String(payload.courier_name ?? payload.courier ?? shipment?.courier_name ?? ""), shiprocketShipmentId, shiprocketOrderId, now, matchedOrder.id),
      ];
      if (fromStatus !== newStatus) {
        statements.push(
          db.prepare(`INSERT INTO order_status_log (id, order_id, from_status, to_status, changed_by, reason, created_at) VALUES (?1, ?2, ?3, ?4, 'shiprocket_webhook', ?5, ?6)`)
            .bind(`log_${randomHex(8)}`, matchedOrder.id, fromStatus, newStatus, `Shiprocket tracking event: ${newStatus}`, now),
        );
      }
      await db.batch(statements);

      if (newStatus === "PICKED_UP") {
        await applyShipmentTransition(matchedOrder.id, "shiprocket_webhook");
      }

      if (newStatus === "SHIPMENT_AUTO_CANCELLED") {
        await db.prepare("UPDATE order_requirements SET allocated_quantity=0 WHERE order_id=?1").bind(matchedOrder.id).run();
        await reallocateComponents();
      }

      if (newStatus === "RTO_RECEIVED") {
        await db.prepare("INSERT INTO rto_tasks (id, order_id, status, created_at) VALUES (?1, ?2, 'qc-pending', ?3) ON CONFLICT(id) DO NOTHING").bind(`rto_${matchedOrder.id}`, matchedOrder.id, now).run();
      }

      await broadcastOrderUpdate(matchedOrder.id, "shiprocket.webhook");
      await recordWebhookDiagnostic("webhook.shiprocket.processed", `Status ${newStatus} processed for order ${matchedOrder.id}`);
    }

    return new Response("OK");
  } catch (error) {
    try { await db.prepare("DELETE FROM webhook_receipts WHERE id=?1").bind(receiptId).run(); }
    catch (cleanupError) { console.error("Could not release failed Shiprocket webhook claim", cleanupError); }
    const detail = error instanceof Error ? error.message : "Unknown Shiprocket webhook error";
    await recordWebhookDiagnostic("webhook.shiprocket.failed", `Status ${statusCode || "missing"} failed: ${detail.slice(0, 300)}`);
    console.error("Shiprocket webhook processing failed", { receiptId, awb, statusCode, detail });
    return Response.json({ error: "Shiprocket webhook processing failed", detail }, { status: 500 });
  }
}

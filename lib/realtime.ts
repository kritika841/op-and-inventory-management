import { getEnv } from "./database";

const HUB_NAME = "satmi-order-events";

const WAREHOUSE_STATUSES = new Set([
  "MANIFESTED",
  "LABEL_PRINTED",
  "PICKUP_SCHEDULED",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "AUTO_CANCEL_RISK",
  "SHIPMENT_AUTO_CANCELLED",
  "RTO_INITIATED",
  "RTO_IN_TRANSIT",
  "RTO_RECEIVED",
  "RTO_INSPECTION_PENDING",
  "RTO_RESTOCKED",
  "RTO_DAMAGED",
]);

type OrderRealtimeRow = {
  id: string;
  assigned_user_id: string | null;
  current_status: string | null;
  status: string | null;
  updated_at: string | null;
};

export type OrderRealtimeEvent = {
  type: "order.updated";
  source: string;
  changedAt: string;
  order: {
    id: string;
    assignedUserId: string | null;
    currentStatus: string;
    status: string;
    warehouseVisible: boolean;
  };
};

function getHubStub() {
  const hub = getEnv().ORDER_EVENTS;
  if (!hub) return null;
  return hub.get(hub.idFromName(HUB_NAME));
}

export async function broadcastOrderUpdate(orderId: string, source: string) {
  const row = await getEnv().DB.prepare(
    "SELECT id,assigned_user_id,current_status,status,updated_at FROM orders WHERE id=?1 LIMIT 1",
  ).bind(orderId).first<OrderRealtimeRow>();
  if (!row) return;

  const currentStatus = String(row.current_status || "INGESTED");
  const payload: OrderRealtimeEvent = {
    type: "order.updated",
    source,
    changedAt: row.updated_at || new Date().toISOString(),
    order: {
      id: String(row.id),
      assignedUserId: row.assigned_user_id ? String(row.assigned_user_id) : null,
      currentStatus,
      status: String(row.status || "").toLowerCase(),
      warehouseVisible: WAREHOUSE_STATUSES.has(currentStatus),
    },
  };

  const stub = getHubStub();
  if (!stub) return;

  // Provider webhooks must never be marked failed solely because the optional
  // live-update channel is unavailable. The durable object is an acceleration
  // layer; the database status is the system of record.
  try {
    await stub.fetch("https://order-events.internal/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn("Order was saved but realtime broadcast was unavailable", { orderId, source, error: error instanceof Error ? error.message : String(error) });
  }
}

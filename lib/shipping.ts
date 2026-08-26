export const PRE_PICKUP_CURRENT_STATUSES = new Set([
  "MANIFESTED",
  "LABEL_PRINTED",
  "PICKUP_SCHEDULED",
  "AUTO_CANCEL_RISK",
]);

export const COURIER_ACTIVE_CURRENT_STATUSES = new Set([
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RTO_INITIATED",
  "RTO_IN_TRANSIT",
  "RTO_RECEIVED",
  "RTO_RESTOCKED",
  "RTO_INSPECTION_PENDING",
  "RTO_DAMAGED",
]);

const TRACKING_BY_CODE: Record<string, string> = {
  "1": "awb_assigned",
  "2": "label_generated",
  "3": "pickup_scheduled",
  "4": "pickup_queued",
  "5": "manifest_generated",
  "6": "shipped",
  "7": "delivered",
  "8": "cancelled",
  "9": "rto_initiated",
  "10": "rto_delivered",
  "11": "pending",
  "12": "lost",
  "13": "pickup_error",
  "14": "rto_acknowledged",
  "15": "pickup_rescheduled",
  "16": "cancellation_requested",
  "17": "out_for_delivery",
  "18": "in_transit",
  "19": "out_for_pickup",
  "20": "pickup_exception",
  "21": "undelivered",
  "22": "delayed",
  "23": "partial_delivered",
  "24": "destroyed",
  "25": "damaged",
  "26": "fulfilled",
  "38": "reached_destination",
  "39": "misrouted",
  "40": "rto_ndr",
  "41": "fulfilled",
  "42": "picked_up",
  "43": "self_fulfilled",
  "44": "rto_ofd",
  "45": "rto_undelivered",
  "46": "rto_in_transit",
  "47": "qc_failed",
  "48": "reached_warehouse",
  "49": "custom_cleared",
  "50": "in_flight",
  "51": "handover_to_courier",
  "52": "shipment_booked",
  "54": "in_transit",
  "55": "rto_in_transit",
  "56": "return_pickup_generated",
  "57": "return_pickup_queued",
  "58": "return_pickup_rescheduled",
  "59": "return_picked_up",
  "67": "rto_in_transit",
  "75": "rto_in_transit",
  "77": "cancelled",
};

export function normalizeShiprocketTracking(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "pending";
  return TRACKING_BY_CODE[raw] ?? raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function normalizeShiprocketCurrentStatus(value: unknown) {
  const tracking = normalizeShiprocketTracking(value);
  const byTracking: Record<string, string> = {
    pending: "INGESTED",
    order_received: "INGESTED",
    awb_generated: "MANIFESTED",
    awb_assigned: "MANIFESTED",
    manifest_generated: "MANIFESTED",
    shipment_booked: "MANIFESTED",
    label_generated: "LABEL_PRINTED",
    pickup_scheduled: "PICKUP_SCHEDULED",
    pickup_queued: "PICKUP_SCHEDULED",
    pickup_rescheduled: "PICKUP_SCHEDULED",
    out_for_pickup: "PICKUP_SCHEDULED",
    pickup_error: "PICKUP_SCHEDULED",
    pickup_exception: "PICKUP_SCHEDULED",
    picked_up: "PICKED_UP",
    handover_to_courier: "PICKED_UP",
    shipped: "IN_TRANSIT",
    in_transit: "IN_TRANSIT",
    in_flight: "IN_TRANSIT",
    reached_destination: "IN_TRANSIT",
    reached_at_destination_hub: "IN_TRANSIT",
    reached_warehouse: "IN_TRANSIT",
    custom_cleared: "IN_TRANSIT",
    misrouted: "IN_TRANSIT",
    delayed: "IN_TRANSIT",
    fulfilled: "IN_TRANSIT",
    self_fulfilled: "IN_TRANSIT",
    out_for_delivery: "OUT_FOR_DELIVERY",
    undelivered: "OUT_FOR_DELIVERY",
    delivered: "DELIVERED",
    partial_delivered: "DELIVERED",
    cancelled: "SHIPMENT_AUTO_CANCELLED",
    cancelled_after_awb: "SHIPMENT_AUTO_CANCELLED",
    cancelled_before_awb: "SHIPMENT_AUTO_CANCELLED",
    cancellation_requested: "SHIPMENT_AUTO_CANCELLED",
    lost: "SHIPMENT_AUTO_CANCELLED",
    destroyed: "SHIPMENT_AUTO_CANCELLED",
    rto_initiated: "RTO_INITIATED",
    rto_acknowledged: "RTO_INITIATED",
    rto_ndr: "RTO_INITIATED",
    rto_in_transit: "RTO_IN_TRANSIT",
    rto_in_intransit: "RTO_IN_TRANSIT",
    rto_ofd: "RTO_IN_TRANSIT",
    rto_undelivered: "RTO_IN_TRANSIT",
    rto_reached_hub: "RTO_IN_TRANSIT",
    return_picked_up: "RTO_IN_TRANSIT",
    rto_delivered: "RTO_RECEIVED",
    damaged: "RTO_DAMAGED",
    qc_failed: "RTO_INSPECTION_PENDING",
  };
  if (byTracking[tracking]) return byTracking[tracking];
  if (tracking === "rto_delivered") return "RTO_RECEIVED";
  if (tracking.startsWith("rto_") || tracking.startsWith("return_")) return "RTO_IN_TRANSIT";
  if (tracking.includes("deliver")) return "DELIVERED";
  if (tracking.includes("transit") || tracking.includes("dest") || tracking.includes("route") || tracking.includes("flight") || tracking.includes("ship")) return "IN_TRANSIT";
  if (tracking.includes("pickup") || tracking.includes("manifest") || tracking.includes("label") || tracking.includes("awb")) return "PICKUP_SCHEDULED";
  if (tracking.includes("cancel") || tracking.includes("lost") || tracking.includes("destroy")) return "SHIPMENT_AUTO_CANCELLED";
  return "INGESTED";
}

export function normalizeShiprocketOrderStatus(value: unknown) {
  const tracking = normalizeShiprocketTracking(value);
  if (tracking === "rto_delivered") return "rto_delivered";
  if (tracking.startsWith("rto_") || tracking.startsWith("return_")) return "rto_in_transit";
  if (tracking === "delivered" || tracking === "partial_delivered") return "delivered";
  if (tracking.includes("cancel") || tracking.includes("lost") || tracking.includes("destroy")) return "cancelled";
  if (tracking.includes("ship") || tracking.includes("pickup") || tracking.includes("transit") || tracking.includes("dest") || tracking === "out_for_delivery" || tracking === "undelivered" || tracking === "fulfilled" || tracking === "reached_destination") return "shipped";
  return "open";
}

export function fulfillmentShipmentBucket(input: { currentStatus?: unknown; trackingStatus?: unknown; awb?: unknown; pickedUpAt?: unknown }) {
  const currentStatus = String(input.currentStatus ?? normalizeShiprocketCurrentStatus(input.trackingStatus)).toUpperCase();
  if (Boolean(input.pickedUpAt) || COURIER_ACTIVE_CURRENT_STATUSES.has(currentStatus)) return "shipped";
  if (Boolean(input.awb) || PRE_PICKUP_CURRENT_STATUSES.has(currentStatus)) return "labels-generated";
  return "new-orders";
}

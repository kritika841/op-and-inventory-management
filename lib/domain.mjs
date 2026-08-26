export function deriveBlocker(order) {
  if (["cancelled", "delivered", "rto_delivered"].includes(order.status)) return null;
  if (["picked_up", "shipped", "in_transit", "out_for_delivery", "delivered", "rto_initiated", "rto_in_transit", "rto_delivered"].includes(order.trackingStatus || order.status)) return null;
  if (order.lines.some((line) => !line.sku || !line.productId)) return "invalid-SKU";
  if (!order.requirementStatus || order.requirementStatus === "missing") return "recipe-missing";
  if (order.requirementStatus === "packaging-required") return "packaging-plan-required";
  if (order.requirements?.some((item) => item.allocatedQuantity < item.requiredQuantity)) return "component-shortage";
  if (order.confirmationSelected && order.confirmationStatus !== "confirmed") return "confirmation-pending";
  if (!order.shiprocketOrderId) return "Shiprocket-missing";
  if (!order.awb) return "AWB-missing";
  if (!order.labelKey) return "label-missing";
  return null;
}

export function isProcessed(order) {
  return deriveBlocker(order) === null && !["cancelled", "delivered", "rto_delivered"].includes(order.status);
}

export function inventoryAvailability(onHand, allocated) {
  return onHand - allocated;
}

export function calculateBoxPlan(units, boxes) {
  if (!Number.isInteger(units) || units < 1) return [];
  const sorted = [...boxes]
    .filter((box) => Number.isInteger(box.capacity) && box.capacity > 0)
    .sort((a, b) => b.capacity - a.capacity || String(a.componentId).localeCompare(String(b.componentId)));
  const plans = Array(units + 1).fill(null);
  plans[0] = new Map();
  for (let packed = 1; packed <= units; packed += 1) {
    for (const box of sorted) {
      const prior = packed >= box.capacity ? plans[packed - box.capacity] : null;
      if (!prior) continue;
      const candidate = new Map(prior);
      candidate.set(box.componentId, (candidate.get(box.componentId) ?? 0) + 1);
      const candidateCount = [...candidate.values()].reduce((sum, quantity) => sum + quantity, 0);
      const currentCount = plans[packed] ? [...plans[packed].values()].reduce((sum, quantity) => sum + quantity, 0) : Infinity;
      if (candidateCount < currentCount) plans[packed] = candidate;
    }
  }
  if (!plans[units]) return null;
  return sorted
    .filter((box) => plans[units].has(box.componentId))
    .map((box) => ({ componentId: box.componentId, quantity: plans[units].get(box.componentId) }));
}

export function projectRtoEta(shiprocketEta, initiatedAt, historicalMedianDays, fallbackDays = 10) {
  if (shiprocketEta) return { date: shiprocketEta, estimated: false };
  const days = historicalMedianDays && historicalMedianDays > 0 ? historicalMedianDays : fallbackDays;
  return { date: new Date(new Date(initiatedAt).getTime() + days * 86_400_000).toISOString(), estimated: true };
}

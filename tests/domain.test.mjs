import assert from "node:assert/strict";
import test from "node:test";
import { calculateBoxPlan, deriveBlocker, inventoryAvailability, isProcessed, projectRtoEta } from "../lib/domain.mjs";

const ready = { status: "open", trackingStatus: null, lines: [{ id: "1", productId: "product-1", sku: "SKU-1", quantity: 2, allocatedQuantity: 0 }], requirementStatus: "complete", requirements: [{ requiredQuantity: 5, allocatedQuantity: 5 }], confirmationSelected: true, confirmationStatus: "confirmed", shiprocketOrderId: "100", awb: "AWB", labelKey: "label.pdf" };

test("warehouse-ready requires confirmation, stock, AWB and label", () => {
  assert.equal(deriveBlocker(ready), null);
  assert.equal(isProcessed(ready), true);
  assert.equal(deriveBlocker({ ...ready, confirmationStatus: "assigned" }), "confirmation-pending");
  assert.equal(deriveBlocker({ ...ready, awb: null }), "AWB-missing");
  assert.equal(deriveBlocker({ ...ready, labelKey: null }), "label-missing");
});

test("stock shortage has priority over downstream fulfillment blockers", () => {
  const order = { ...ready, requirements: [{ requiredQuantity: 5, allocatedQuantity: 4 }], shiprocketOrderId: null, awb: null, labelKey: null };
  assert.equal(deriveBlocker(order), "component-shortage");
  assert.equal(inventoryAvailability(9, 12), -3);
});

test("recipe and packaging configuration block before allocation", () => {
  assert.equal(deriveBlocker({ ...ready, requirementStatus: "missing" }), "recipe-missing");
  assert.equal(deriveBlocker({ ...ready, requirementStatus: "packaging-required" }), "packaging-plan-required");
});

test("deterministic courier-box plans use largest capacity first", () => {
  const boxes = [{ componentId: "large", capacity: 3 }, { componentId: "medium", capacity: 2 }, { componentId: "small", capacity: 1 }];
  assert.deepEqual(calculateBoxPlan(1, boxes), [{ componentId: "small", quantity: 1 }]);
  assert.deepEqual(calculateBoxPlan(2, boxes), [{ componentId: "medium", quantity: 1 }]);
  assert.deepEqual(calculateBoxPlan(3, boxes), [{ componentId: "large", quantity: 1 }]);
  assert.deepEqual(calculateBoxPlan(4, boxes), [{ componentId: "large", quantity: 1 }, { componentId: "small", quantity: 1 }]);
  assert.deepEqual(calculateBoxPlan(5, boxes), [{ componentId: "large", quantity: 1 }, { componentId: "medium", quantity: 1 }]);
  assert.deepEqual(calculateBoxPlan(6, boxes), [{ componentId: "large", quantity: 2 }]);
  assert.equal(calculateBoxPlan(2, [{ componentId: "large", capacity: 3 }]), null);
  assert.deepEqual(calculateBoxPlan(2, [{ componentId: "small", capacity: 1 }]), [{ componentId: "small", quantity: 2 }]);
  assert.deepEqual(calculateBoxPlan(4, [{ componentId: "medium", capacity: 2 }, { componentId: "small", capacity: 1 }]), [{ componentId: "medium", quantity: 2 }]);
  assert.deepEqual(calculateBoxPlan(7, [{ componentId: "large", capacity: 5 }, { componentId: "small", capacity: 2 }]), [{ componentId: "large", quantity: 1 }, { componentId: "small", quantity: 1 }]);
  assert.deepEqual(calculateBoxPlan(6, [{ componentId: "five-unit", capacity: 5 }, { componentId: "three-unit", capacity: 3 }]), [{ componentId: "three-unit", quantity: 2 }]);
});

test("carrier pickup freezes the processed decision after stock is deducted", () => {
  const shipped = { ...ready, trackingStatus: "shipped", lines: [{ ...ready.lines[0], allocatedQuantity: 0 }] };
  assert.equal(deriveBlocker(shipped), null);
  assert.equal(isProcessed(shipped), true);
});

test("a missing product mapping is an invalid SKU blocker", () => {
  assert.equal(deriveBlocker({ ...ready, lines: [{ ...ready.lines[0], productId: null }] }), "invalid-SKU");
});

test("RTO ETA uses provider date, historical median, then ten-day fallback", () => {
  const started = "2026-07-01T00:00:00.000Z";
  assert.deepEqual(projectRtoEta("2026-07-04T00:00:00.000Z", started, 8), { date: "2026-07-04T00:00:00.000Z", estimated: false });
  assert.equal(projectRtoEta(null, started, 6).date, "2026-07-07T00:00:00.000Z");
  assert.equal(projectRtoEta(null, started, null).date, "2026-07-11T00:00:00.000Z");
});

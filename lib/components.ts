import { audit, ensureDatabase, getEnv } from "./database";
import { randomHex } from "./crypto";
import type { AppUser, ComponentType } from "./types";

type Row = Record<string, unknown>;
const n = (value: unknown) => Number(value ?? 0);
const dispatchedTracking = new Set(["picked_up", "shipped", "in_transit", "out_for_delivery", "delivered", "rto_initiated", "rto_in_transit", "rto_delivered", "fulfilled", "self_fulfilled", "reached_destination"]);

export function isDispatched(status: unknown, tracking: unknown) {
  return ["shipped", "delivered", "rto_in_transit", "rto_delivered"].includes(String(status)) || dispatchedTracking.has(String(tracking || ""));
}

export async function snapshotOrderRequirements(orderId: string, actorId: string | null = null, force = false, preserveRecipeVersions = false, skipReallocate = false) {
  await ensureDatabase(); const db = getEnv().DB;
  const order = await db.prepare("SELECT status,tracking_status FROM orders WHERE id=?1").bind(orderId).first<Row>();
  if (!order || isDispatched(order.status, order.tracking_status)) return { status: "historical" as const };
  const prior = await db.prepare("SELECT status FROM order_requirement_sets WHERE order_id=?1").bind(orderId).first<Row>();
  if (prior && !force) return { status: String(prior.status) };
  const lines = await db.prepare("SELECT id,product_id,quantity FROM order_lines WHERE order_id=?1").bind(orderId).all<Row>();
  const now = new Date().toISOString();
  const requirements: Array<{ lineId: string | null; componentId: string; source: "BOM" | "COURIER_BOX"; quantity: number; recipeId: string | null }> = [];
  let missing = false;
  for (const line of lines.results) {
    if (!line.product_id) { missing = true; continue; }
    const priorRecipe = preserveRecipeVersions
      ? await db.prepare("SELECT recipe_version_id FROM order_requirements WHERE order_line_id=?1 AND recipe_version_id IS NOT NULL LIMIT 1").bind(line.id).first<Row>()
      : null;
    const recipe = priorRecipe?.recipe_version_id
      ? await db.prepare("SELECT id,packaging_profile_id,packing_units FROM recipe_versions WHERE id=?1").bind(priorRecipe.recipe_version_id).first<Row>()
      : await db.prepare("SELECT id,packaging_profile_id,packing_units FROM recipe_versions WHERE product_id=?1 AND status='active' ORDER BY version DESC LIMIT 1").bind(line.product_id).first<Row>();
    if (!recipe) { missing = true; continue; }
    const items = await db.prepare("SELECT ri.component_id,ri.quantity,c.id AS active_component_id,c.component_type FROM recipe_items ri LEFT JOIN inventory_components c ON c.id=ri.component_id AND c.active=1 WHERE ri.recipe_version_id=?1").bind(recipe.id).all<Row>();
    if (!items.results.length || items.results.some((item) => !item.active_component_id)) { missing = true; continue; }
    for (const item of items.results) requirements.push({ lineId: String(line.id), componentId: String(item.component_id), source: String(item.component_type) === "COURIER_BOX" ? "COURIER_BOX" : "BOM", quantity: n(item.quantity) * n(line.quantity), recipeId: String(recipe.id) });
  }
  const setStatus = missing ? "missing" : "complete";
  const planId = `pack_${orderId}`;
  const statements = [
    db.prepare("DELETE FROM order_requirements WHERE order_id=?1").bind(orderId), db.prepare("DELETE FROM packaging_plan_lines WHERE plan_id=?1").bind(planId),
    db.prepare("INSERT INTO order_requirement_sets(order_id,status,updated_at) VALUES(?1,?2,?3) ON CONFLICT(order_id) DO UPDATE SET status=?2,updated_at=?3").bind(orderId, setStatus, now),
    db.prepare("INSERT INTO packaging_plans(id,order_id,status,mixed_profile,created_by,updated_at) VALUES(?1,?2,'component-recipe',0,?3,?4) ON CONFLICT(order_id) DO UPDATE SET status='component-recipe',mixed_profile=0,created_by=?3,updated_at=?4").bind(planId, orderId, actorId, now),
    ...requirements.map((req) => db.prepare("INSERT INTO order_requirements(id,order_id,order_line_id,component_id,source,required_quantity,allocated_quantity,recipe_version_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,0,?7,?8)").bind(`req_${randomHex(9)}`, orderId, req.lineId, req.componentId, req.source, req.quantity, req.recipeId, now)),
  ];
  await db.batch(statements);
  if (!skipReallocate) await reallocateComponents();
  return { status: setStatus };
}

export async function reallocateComponents() {
  await ensureDatabase(); const db = getEnv().DB;
  const requirements = await db.prepare(`SELECT r.id,r.component_id,r.required_quantity,o.created_at,o.status,o.tracking_status FROM order_requirements r JOIN orders o ON o.id=r.order_id WHERE o.status NOT IN ('cancelled','delivered','rto_delivered') ORDER BY o.created_at ASC,r.id ASC`).all<Row>();
  if (requirements.results.length) await db.batch(requirements.results.map((row) => db.prepare("UPDATE order_requirements SET allocated_quantity=0 WHERE id=?1").bind(row.id)));
  const byComponent = new Map<string, Row[]>();
  for (const row of requirements.results) if (!isDispatched(row.status, row.tracking_status)) byComponent.set(String(row.component_id), [...(byComponent.get(String(row.component_id)) ?? []), row]);
  for (const [componentId, rows] of byComponent) {
    const balance = await db.prepare("SELECT COALESCE(SUM(quantity),0) AS qty FROM component_ledger WHERE component_id=?1").bind(componentId).first<Row>();
    let available = Math.max(0, n(balance?.qty));
    const updates = rows.map((row) => { const allocated = Math.min(n(row.required_quantity), available); available -= allocated; return db.prepare("UPDATE order_requirements SET allocated_quantity=?1 WHERE id=?2").bind(allocated, row.id); });
    if (updates.length) await db.batch(updates);
  }
}

export async function saveRecipe(actor: AppUser, productId: string, payload: { packagingProfileId: string; packingUnits: number; items: Array<{ componentId: string; quantity: number }>; applyTo: "new" | "unshipped" }) {
  await ensureDatabase(); const db = getEnv().DB;
  if (!payload.packagingProfileId || !Number.isInteger(payload.packingUnits) || payload.packingUnits < 1 || !payload.items.length || payload.items.some((item) => !item.componentId || !Number.isInteger(item.quantity) || item.quantity < 1)) throw new Error("A product needs a valid packing unit count and positive whole component quantities");
  if (new Set(payload.items.map((item) => item.componentId)).size !== payload.items.length) throw new Error("This component is already in the product. Increase its quantity instead");
  const product = await db.prepare("SELECT id FROM products WHERE id=?1").bind(productId).first(); if (!product) throw new Error("Sellable product not found");
  const profile = await db.prepare("SELECT id FROM packaging_profiles WHERE id=?1 AND active=1").bind(payload.packagingProfileId).first();
  if (!profile) throw new Error("Packaging profile not found");
  for (const item of payload.items) {
    const component = await db.prepare("SELECT component_type FROM inventory_components WHERE id=?1 AND active=1").bind(item.componentId).first<Row>();
    if (!component) throw new Error("Every recipe item must reference an active inventory component");
  }
  const max = await db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM recipe_versions WHERE product_id=?1").bind(productId).first<Row>();
  const version = n(max?.version) + 1; const recipeId = `rcp_${randomHex(9)}`; const now = new Date().toISOString();
  await db.batch([db.prepare("UPDATE recipe_versions SET status='archived' WHERE product_id=?1").bind(productId), db.prepare("INSERT INTO recipe_versions(id,product_id,version,status,packaging_profile_id,packing_units,created_by,created_at) VALUES(?1,?2,?3,'active',?4,?5,?6,?7)").bind(recipeId, productId, version, payload.packagingProfileId, payload.packingUnits, actor.id, now), ...payload.items.map((item) => db.prepare("INSERT INTO recipe_items(id,recipe_version_id,component_id,quantity) VALUES(?1,?2,?3,?4)").bind(`rci_${randomHex(8)}`, recipeId, item.componentId, item.quantity))]);
  if (payload.applyTo === "unshipped") {
    const orders = await db.prepare("SELECT DISTINCT o.id,o.status,o.tracking_status FROM orders o JOIN order_lines ol ON ol.order_id=o.id WHERE ol.product_id=?1 AND o.status NOT IN ('cancelled','delivered','rto_delivered')").bind(productId).all<Row>();
    for (const order of orders.results) if (!isDispatched(order.status, order.tracking_status)) await snapshotOrderRequirements(String(order.id), actor.id, true);
  }
  await audit(actor.id, "recipe.version-created", "product", productId, `Version ${version} · ${payload.applyTo}`); return { recipeId, version };
}

export async function createProductWithRecipe(actor: AppUser, payload: { name: string; sku: string; variant?: string; packagingProfileId: string; items: Array<{ componentId: string; quantity: number }> }) {
  const name = payload.name.trim(); const sku = payload.sku.trim().toUpperCase(); const variant = payload.variant?.trim() || "Default";
  if (!name || !sku) throw new Error("Product name and SKU are required");
  if (!payload.packagingProfileId || !payload.items.length || payload.items.some((item) => !item.componentId || !Number.isInteger(item.quantity) || item.quantity < 1)) throw new Error("Add at least one component with a positive whole quantity");
  if (new Set(payload.items.map((item) => item.componentId)).size !== payload.items.length) throw new Error("This component is already in the product. Increase its quantity instead");
  await ensureDatabase(); const db = getEnv().DB;
  if (await db.prepare("SELECT id FROM products WHERE sku=?1").bind(sku).first()) throw new Error("A product with this SKU already exists");
  if (!await db.prepare("SELECT id FROM packaging_profiles WHERE id=?1 AND active=1").bind(payload.packagingProfileId).first()) throw new Error("Product configuration is unavailable");
  for (const item of payload.items) if (!await db.prepare("SELECT id FROM inventory_components WHERE id=?1 AND active=1").bind(item.componentId).first()) throw new Error("Every recipe item must reference an active component");
  const productId = `prd_manual_${randomHex(8)}`; const recipeId = `rcp_${randomHex(9)}`; const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO products(id,sku,name,variant,active) VALUES(?1,?2,?3,?4,1)").bind(productId, sku, name, variant),
    db.prepare("INSERT INTO recipe_versions(id,product_id,version,status,packaging_profile_id,packing_units,created_by,created_at) VALUES(?1,?2,1,'active',?3,1,?4,?5)").bind(recipeId, productId, payload.packagingProfileId, actor.id, now),
    ...payload.items.map((item) => db.prepare("INSERT INTO recipe_items(id,recipe_version_id,component_id,quantity) VALUES(?1,?2,?3,?4)").bind(`rci_${randomHex(8)}`, recipeId, item.componentId, item.quantity)),
  ]);
  await audit(actor.id, "product.created", "product", productId, `${sku} · ${name} · recipe v1`);
  return productId;
}

export async function deactivateProduct(actor: AppUser, productId: string) {
  await ensureDatabase(); const db = getEnv().DB;
  const product = await db.prepare("SELECT id,sku,name FROM products WHERE id=?1 AND active=1").bind(productId).first<Row>();
  if (!product) throw new Error("Active product not found");
  await db.batch([
    db.prepare("UPDATE products SET active=0 WHERE id=?1").bind(productId),
    db.prepare("UPDATE recipe_versions SET status='archived' WHERE product_id=?1 AND status='active'").bind(productId),
  ]);
  await audit(actor.id, "product.deleted", "product", productId, `${product.sku} · ${product.name} · removed from local catalog only`);
}

export async function confirmPackagingPlan(actor: AppUser, orderId: string, lines: Array<{ componentId: string; quantity: number }>) {
  await ensureDatabase(); const db = getEnv().DB;
  if (!lines.length || lines.some((line) => !line.componentId || !Number.isInteger(line.quantity) || line.quantity < 1)) throw new Error("Choose at least one courier box with a positive whole quantity");
  const unique = new Map<string, number>(); for (const line of lines) unique.set(line.componentId, (unique.get(line.componentId) ?? 0) + line.quantity);
  const order = await db.prepare("SELECT o.id,o.status,o.tracking_status,s.status AS requirement_status FROM orders o LEFT JOIN order_requirement_sets s ON s.order_id=o.id WHERE o.id=?1").bind(orderId).first<Row>();
  if (!order) throw new Error("Order not found");
  if (isDispatched(order.status, order.tracking_status)) throw new Error("Packaging cannot be changed after dispatch");
  if (String(order.requirement_status || "") === "missing") throw new Error("Complete every product recipe before confirming packaging");
  for (const componentId of unique.keys()) { const box = await db.prepare("SELECT id FROM inventory_components WHERE id=?1 AND component_type='COURIER_BOX' AND active=1").bind(componentId).first(); if (!box) throw new Error("Packaging plans may contain active courier-box components only"); }
  const planId = `pack_${orderId}`; const now = new Date().toISOString();
  await db.batch([db.prepare("DELETE FROM packaging_plan_lines WHERE plan_id=?1").bind(planId), db.prepare("DELETE FROM order_requirements WHERE order_id=?1 AND source='COURIER_BOX'").bind(orderId), db.prepare("INSERT INTO packaging_plans(id,order_id,status,mixed_profile,created_by,updated_at) VALUES(?1,?2,'manual',1,?3,?4) ON CONFLICT(order_id) DO UPDATE SET status='manual',created_by=?3,updated_at=?4").bind(planId, orderId, actor.id, now), db.prepare("UPDATE order_requirement_sets SET status='complete',updated_at=?1 WHERE order_id=?2 AND status<>'missing'").bind(now, orderId), ...[...unique].flatMap(([componentId, quantity]) => [db.prepare("INSERT INTO packaging_plan_lines(id,plan_id,component_id,quantity) VALUES(?1,?2,?3,?4)").bind(`pkl_${randomHex(8)}`, planId, componentId, quantity), db.prepare("INSERT INTO order_requirements(id,order_id,component_id,source,required_quantity,allocated_quantity,created_at) VALUES(?1,?2,?3,'COURIER_BOX',?4,0,?5)").bind(`req_${randomHex(9)}`, orderId, componentId, quantity, now)])]);
  await reallocateComponents(); await audit(actor.id, "packaging.manual-confirmed", "order", orderId, [...unique].map(([id, qty]) => `${id}×${qty}`).join(", "));
}

export async function adjustComponentInventory(actor: AppUser, componentId: string, quantity: number, reason: string, movementType = "adjustment") {
  if (!Number.isInteger(quantity) || quantity === 0 || !reason.trim() || reason.trim().length > 240) throw new Error("A non-zero whole quantity and reason of 240 characters or fewer are required");
  await ensureDatabase(); const db = getEnv().DB;
  const component = await db.prepare("SELECT id FROM inventory_components WHERE id=?1 AND active=1").bind(componentId).first();
  if (!component) throw new Error("Active inventory component not found");
  const balance = await db.prepare("SELECT COALESCE(SUM(quantity),0) AS quantity FROM component_ledger WHERE component_id=?1").bind(componentId).first<Row>();
  if (n(balance?.quantity) + quantity < 0) throw new Error("Adjustment cannot make physical stock negative");
  await db.prepare("INSERT INTO component_ledger(id,component_id,movement_type,quantity,reason,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)").bind(`cled_${randomHex(9)}`, componentId, movementType, quantity, reason, actor.id, new Date().toISOString()).run();
  await reallocateComponents(); await audit(actor.id, "component.adjusted", "component", componentId, `${quantity > 0 ? "+" : ""}${quantity} · ${reason}`);
}

export async function bulkSetComponentInventory(actor: AppUser, items: Array<{ componentId: string; onHand: number }>) {
  if (!items.length || items.length > 500) throw new Error("Choose between 1 and 500 components");
  if (new Set(items.map((item) => item.componentId)).size !== items.length) throw new Error("Each component may appear only once");
  if (items.some((item) => !item.componentId || !Number.isInteger(item.onHand) || item.onHand < 0)) throw new Error("Every stock value must be a positive whole number or zero");
  await ensureDatabase(); const db = getEnv().DB; const now = new Date().toISOString();
  const changes: Array<{ componentId: string; from: number; to: number; delta: number }> = [];
  for (const item of items) {
    const component = await db.prepare("SELECT id FROM inventory_components WHERE id=?1 AND active=1").bind(item.componentId).first();
    if (!component) throw new Error("One of the selected components is no longer active");
    const balance = await db.prepare("SELECT COALESCE(SUM(quantity),0) AS quantity FROM component_ledger WHERE component_id=?1").bind(item.componentId).first<Row>();
    const from = n(balance?.quantity); const delta = item.onHand - from;
    if (delta) changes.push({ componentId: item.componentId, from, to: item.onHand, delta });
  }
  if (changes.length) await db.batch(changes.map((change) => db.prepare("INSERT INTO component_ledger(id,component_id,movement_type,quantity,reason,created_by,created_at) VALUES(?1,?2,'adjustment',?3,?4,?5,?6)").bind(`cled_${randomHex(9)}`, change.componentId, change.delta, `Bulk stock edit: ${change.from} → ${change.to}`, actor.id, now)));
  await reallocateComponents();
  for (const change of changes) await audit(actor.id, "component.bulk-adjusted", "component", change.componentId, `${change.from} → ${change.to}`);
  return changes.length;
}

export async function createComponentType(actor: AppUser, name: string) {
  const cleanName = name.trim().replace(/\s+/g, " ");
  if (cleanName.length < 2 || cleanName.length > 40) throw new Error("Type name must be between 2 and 40 characters");
  const code = cleanName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!code) throw new Error("Enter a valid component type name");
  await ensureDatabase(); const db = getEnv().DB;
  const existing = await db.prepare("SELECT code FROM component_types WHERE code=?1 OR LOWER(name)=LOWER(?2)").bind(code, cleanName).first();
  if (existing) throw new Error("That component type already exists");
  await db.prepare("INSERT INTO component_types(code,name,active,created_at) VALUES(?1,?2,1,?3)").bind(code, cleanName, new Date().toISOString()).run();
  await audit(actor.id, "component-type.created", "component-type", code, cleanName);
  return code;
}

export async function createOrUpdateComponent(actor: AppUser, payload: { id?: string; sku: string; name: string; componentType: ComponentType; unit?: string; rtoRecoverable: boolean; active?: boolean }) {
  await ensureDatabase(); const db = getEnv().DB;
  const sku = payload.sku?.trim().toUpperCase() ?? "";
  const name = payload.name?.trim() ?? "";
  const unit = payload.unit?.trim() || "unit";
  if (!sku || !name || !payload.componentType) throw new Error("Name, SKU and component type are required");
  if (sku.length > 80 || name.length > 160 || unit.length > 40 || /[\u0000-\u001f\u007f]/.test(`${sku}${name}${unit}`)) throw new Error("Component fields are too long or contain unsupported characters");
  const type = await db.prepare("SELECT code FROM component_types WHERE code=?1 AND active=1").bind(payload.componentType).first();
  if (!type) throw new Error("Choose an active component type");
  if (payload.id && payload.active === false) {
    const used = await db.prepare("SELECT ri.id FROM recipe_items ri JOIN recipe_versions rv ON rv.id=ri.recipe_version_id WHERE ri.component_id=?1 AND rv.status='active' LIMIT 1").bind(payload.id).first();
    if (used) throw new Error("Remove this component from active product recipes before deleting it");
  }
  const id = payload.id || `cmp_${randomHex(8)}`; const now = new Date().toISOString();
  await db.prepare("INSERT INTO inventory_components(id,sku,name,component_type,unit,rto_recoverable,active,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8) ON CONFLICT(id) DO UPDATE SET sku=?2,name=?3,component_type=?4,unit=?5,rto_recoverable=?6,active=?7,updated_at=?8").bind(id, sku, name, payload.componentType, unit, payload.componentType === "COURIER_BOX" ? 0 : payload.rtoRecoverable ? 1 : 0, payload.active === false ? 0 : 1, now).run();
  await audit(actor.id, payload.id && payload.active === false ? "component.deleted" : payload.id ? "component.updated" : "component.created", "component", id, `${payload.sku} · ${payload.componentType}`); return id;
}

export async function createPackagingProfile(actor: AppUser, name: string) {
  if (!name.trim()) throw new Error("Profile name is required"); await ensureDatabase(); const id = `pkg_${randomHex(8)}`;
  await getEnv().DB.prepare("INSERT INTO packaging_profiles(id,name,active,created_at) VALUES(?1,?2,1,?3)").bind(id, name.trim(), new Date().toISOString()).run(); await audit(actor.id, "packaging.profile-created", "packaging-profile", id, name.trim()); return id;
}

export async function upsertBoxOption(actor: AppUser, profileId: string, componentId: string, capacity: number) {
  if (!profileId || !componentId || !Number.isInteger(capacity) || capacity < 1) throw new Error("Profile, courier box and a positive whole-unit capacity are required"); await ensureDatabase(); const db = getEnv().DB;
  const profile = await db.prepare("SELECT id FROM packaging_profiles WHERE id=?1 AND active=1").bind(profileId).first(); if (!profile) throw new Error("Packaging profile not found");
  const box = await db.prepare("SELECT id FROM inventory_components WHERE id=?1 AND component_type='COURIER_BOX'").bind(componentId).first(); if (!box) throw new Error("Selected component is not a courier box");
  const id = `pbo_${randomHex(8)}`; await db.prepare("INSERT INTO packaging_box_options(id,profile_id,component_id,capacity,active) VALUES(?1,?2,?3,?4,1) ON CONFLICT(profile_id,component_id) DO UPDATE SET capacity=?4,active=1").bind(id, profileId, componentId, capacity).run(); await audit(actor.id, "packaging.box-rule-saved", "packaging-profile", profileId, `${componentId} capacity ${capacity}`);
}

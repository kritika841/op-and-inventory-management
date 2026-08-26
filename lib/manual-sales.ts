import { audit, ensureDatabase, getEnv } from "./database";
import { randomHex } from "./crypto";
import { reallocateComponents } from "./components";
import type { AppUser } from "./types";

type Row = Record<string, unknown>;
const n = (value: unknown) => Number(value ?? 0);

export async function createManualSale(actor: AppUser, payload: { reference: string; productId: string; quantity: number }) {
  const reference = payload.reference.trim().toUpperCase();
  if (!reference || reference.length > 60 || !payload.productId || !Number.isInteger(payload.quantity) || payload.quantity < 1) throw new Error("Reference, product and a positive whole quantity are required");
  await ensureDatabase(); const db = getEnv().DB;
  if (await db.prepare("SELECT id FROM manual_sales WHERE reference=?1").bind(reference).first()) throw new Error("That sale reference already exists");
  const product = await db.prepare("SELECT id,sku,name FROM products WHERE id=?1 AND active=1").bind(payload.productId).first<Row>();
  if (!product) throw new Error("Active product not found");
  const recipe = await db.prepare("SELECT id FROM recipe_versions WHERE product_id=?1 AND status='active'").bind(payload.productId).first<Row>();
  if (!recipe) throw new Error("Configure the product recipe before recording a sale");
  const recipeItems = await db.prepare("SELECT ri.component_id,ri.quantity,c.sku,c.name,c.component_type,c.rto_recoverable FROM recipe_items ri JOIN inventory_components c ON c.id=ri.component_id AND c.active=1 WHERE ri.recipe_version_id=?1").bind(recipe.id).all<Row>();
  if (!recipeItems.results.length) throw new Error("The product recipe has no active components");
  const requirements: Array<{ componentId: string; sku: string; name: string; quantity: number; recoverable: boolean }> = [];
  for (const item of recipeItems.results) {
    const required = n(item.quantity) * payload.quantity;
    const balance = await db.prepare("SELECT COALESCE(SUM(quantity),0) AS quantity FROM component_ledger WHERE component_id=?1").bind(item.component_id).first<Row>();
    if (n(balance?.quantity) < required) throw new Error(`${item.name} needs ${required}, but only ${n(balance?.quantity)} is in stock`);
    requirements.push({ componentId: String(item.component_id), sku: String(item.sku), name: String(item.name), quantity: required, recoverable: Boolean(n(item.rto_recoverable)) && item.component_type !== "COURIER_BOX" });
  }
  const saleId = `sale_${randomHex(9)}`; const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO manual_sales(id,reference,product_id,product_sku,product_name,quantity,status,created_by,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'dispatched',?7,?8,?8)").bind(saleId, reference, product.id, product.sku, product.name, payload.quantity, actor.id, now),
    ...requirements.flatMap((item) => [
      db.prepare("INSERT INTO manual_sale_components(id,sale_id,component_id,component_sku,component_name,quantity,rto_recoverable) VALUES(?1,?2,?3,?4,?5,?6,?7)").bind(`msc_${randomHex(8)}`, saleId, item.componentId, item.sku, item.name, item.quantity, item.recoverable ? 1 : 0),
      db.prepare("INSERT INTO component_ledger(id,component_id,movement_type,quantity,reference_type,reference_id,reason,created_by,created_at) VALUES(?1,?2,'manual-sale',?3,'manual-sale',?4,?5,?6,?7)").bind(`cled_${randomHex(9)}`, item.componentId, -item.quantity, saleId, `Manual sale ${reference}`, actor.id, now),
    ]),
  ]);
  await reallocateComponents(); await audit(actor.id, "manual-sale.created", "manual-sale", saleId, `${reference} · ${product.sku} × ${payload.quantity}`);
  return saleId;
}

export async function updateManualSaleStatus(actor: AppUser, saleId: string, status: "delivered" | "rto") {
  await ensureDatabase(); const db = getEnv().DB;
  const sale = await db.prepare("SELECT id,reference,status FROM manual_sales WHERE id=?1").bind(saleId).first<Row>();
  if (!sale) throw new Error("Manual sale not found");
  if (sale.status !== "dispatched") throw new Error("This sale has already been completed");
  const now = new Date().toISOString();
  if (status === "delivered") {
    await db.prepare("UPDATE manual_sales SET status='delivered',updated_at=?1 WHERE id=?2 AND status='dispatched'").bind(now, saleId).run();
  } else {
    const returned = await db.prepare("SELECT component_id,component_name,quantity FROM manual_sale_components WHERE sale_id=?1 AND rto_recoverable=1").bind(saleId).all<Row>();
    await db.batch([
      db.prepare("UPDATE manual_sales SET status='rto',updated_at=?1 WHERE id=?2 AND status='dispatched'").bind(now, saleId),
      ...returned.results.map((item) => db.prepare("INSERT INTO component_ledger(id,component_id,movement_type,quantity,reference_type,reference_id,reason,created_by,created_at) VALUES(?1,?2,'manual-rto',?3,'manual-sale',?4,?5,?6,?7)").bind(`cled_${randomHex(9)}`, item.component_id, item.quantity, saleId, `RTO returned for ${sale.reference}`, actor.id, now)),
    ]);
    await reallocateComponents();
  }
  await audit(actor.id, `manual-sale.${status}`, "manual-sale", saleId, String(sale.reference));
}

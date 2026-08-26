import { rejectCrossOrigin, authorizeRequest } from "@/lib/auth";
import { audit, ensureDatabase, getEnv } from "@/lib/database";
import { randomHex } from "@/lib/crypto";
import { reallocateComponents } from "@/lib/components";

export async function POST(request: Request) {
  const csrf = rejectCrossOrigin(request); if (csrf) return csrf;
  const auth = await authorizeRequest(request, ["ADMIN", "MANAGER"]);
  if ("response" in auth) return auth.response;
  const user = auth.user;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".csv")) return Response.json({ error: "Upload a CSV file" }, { status: 400 });
  const rows = (await file.text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = rows.shift()?.toLowerCase().split(",").map((value) => value.trim());
  if (!header?.includes("sku") || !header.includes("quantity")) return Response.json({ error: "CSV requires sku and quantity columns" }, { status: 400 });
  const skuIndex = header.indexOf("sku"); const quantityIndex = header.indexOf("quantity");
  if (!rows.length) return Response.json({ error: "CSV must contain at least one component row" }, { status: 400 });
  await ensureDatabase();
  const db = getEnv().DB; const parsed: Array<{ componentId: string; sku: string; quantity: number }> = []; const seen = new Set<string>();
  for (const row of rows) {
    const cells = row.split(",").map((value) => value.trim()); const sku = cells[skuIndex]?.toUpperCase(); const quantity = Number(cells[quantityIndex]);
    if (!sku || seen.has(sku) || !Number.isInteger(quantity) || quantity < 0) return Response.json({ error: `Invalid or duplicate row for SKU ${sku || "unknown"}` }, { status: 400 });
    const component = await db.prepare("SELECT id FROM inventory_components WHERE sku=?1 AND active=1").bind(sku).first<{ id: string }>();
    if (!component) return Response.json({ error: `Unknown component SKU: ${sku}` }, { status: 400 });
    seen.add(sku); parsed.push({ componentId: component.id, sku, quantity });
  }
  const now = new Date().toISOString();
  const statements = [];
  for (const row of parsed) {
    const current = await db.prepare("SELECT COALESCE(SUM(quantity),0) AS quantity FROM component_ledger WHERE component_id=?1").bind(row.componentId).first<{ quantity: number }>();
    const delta = row.quantity - Number(current?.quantity ?? 0);
    if (delta !== 0) statements.push(db.prepare("INSERT INTO component_ledger(id,component_id,movement_type,quantity,reason,created_by,created_at) VALUES(?1,?2,'adjustment',?3,?4,?5,?6)").bind(`cled_${randomHex(9)}`, row.componentId, delta, `CSV count reconciliation · ${file.name}`, user.id, now));
  }
  if (statements.length) await db.batch(statements);
  await reallocateComponents();
  await audit(user.id, "inventory.csv-imported", "inventory", "opening", `${parsed.length} SKUs from ${file.name}`);
  return Response.json({ ok: true, imported: parsed.length });
}
